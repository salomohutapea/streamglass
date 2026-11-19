"""LAN access controls. While LAN access is on, a proxy client that is not this Mac must be an approved device, and an
approved device cannot reach this Mac's own services or private, link-local and VPN-routed (non-global) addresses
unless the user allows that destination. This-Mac destinations have a hard dev-server port boundary. Loopback clients (this Mac, simulators, adb reverse) are not restricted."""
import asyncio
import fnmatch
import ipaddress
import socket
import time

MAX_DEVICES = 64
MAX_DESTINATIONS = 100
MAX_REQUESTS = 32
REQUEST_TTL_SECONDS = 5 * 60
# An approval lasts this long from the moment it is given. Addresses on shared networks are reassigned, so an old
# approval would otherwise pass to whichever device takes over the address.
DEVICE_TTL_SECONDS = 24 * 60 * 60
# Keep setup-site dev-server reservations in sync with this policy.
DEV_SERVER_PORTS = frozenset({3000, 3001, 4200, 5000, 5173, 7000, 8000, 8080, 8081, 8888, 19000, 19001, 19002, 19006})
DEVICE_REFUSED = "Device is not approved to use this proxy. Approve it in Streamglass."
TRANSLATION_PREFIXES = (ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("64:ff9b:1::/48"))


def _address(value):
    try:
        address = ipaddress.ip_address(str(value).strip("[]").split("%", 1)[0])
    except ValueError:
        return None
    return address.ipv4_mapped or address if address.version == 6 else address


def client_ip(client):
    peer = getattr(client, "peername", None)
    address = _address(peer[0]) if peer else None
    return str(address) if address else ""


def is_lan_client(client):
    address = _address(client_ip(client))
    return address is not None and not address.is_loopback


def is_this_mac(address):
    """Check interface ownership without connecting or sending packets.

    Binding covers secondary/VPN and global IPv6 interfaces too. Do not cache
    across network changes: hostname resolution alone misses these addresses.
    """
    if address.is_loopback or address.is_unspecified:
        return True
    if address.is_multicast:
        return False
    scopes = [0]
    if address.version == 6 and address.is_link_local:
        try:
            scopes = [index for index, _ in socket.if_nameindex()]
        except OSError:
            return False
    for scope in scopes:
        try:
            with socket.socket(socket.AF_INET6 if address.version == 6 else socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.bind((str(address), 0, 0, scope) if address.version == 6 else (str(address), 0))
            return True
        except OSError:
            continue
    return False


def restricted(address):
    """Loopback, private, link-local, shared (CGNAT), reserved and multicast addresses are not public destinations."""
    if address.version == 6:
        if address in TRANSLATION_PREFIXES[0]:
            address = ipaddress.IPv4Address(int(address) & 0xffffffff)
        elif address.is_site_local or address in TRANSLATION_PREFIXES[1]:
            return True
    return not address.is_global or address.is_multicast


def validate_devices(value):
    if not isinstance(value, list) or len(value) > MAX_DEVICES:
        raise ValueError(f"lanDevices must list at most {MAX_DEVICES} device addresses")
    devices = []
    for item in value:
        address = _address(item) if isinstance(item, str) and len(item) <= 64 else None
        if address is None or address.is_loopback or address.is_unspecified or address.is_multicast:
            raise ValueError("lanDevices must contain device IP addresses")
        if str(address) not in devices:
            devices.append(str(address))
    return devices


def validate_destinations(value):
    if not isinstance(value, list) or len(value) > MAX_DESTINATIONS:
        raise ValueError(f"lanAllowedDestinations must list at most {MAX_DESTINATIONS} entries")
    result = []
    for item in value:
        if not isinstance(item, str) or not item or len(item) > 255:
            raise ValueError("lanAllowedDestinations must contain host patterns, IP addresses or CIDR ranges")
        text = item.strip().lower()
        try:
            network = ipaddress.ip_network(text, strict=False)
        except ValueError:
            network = None
        if network is not None:
            if network.prefixlen == 0:
                raise ValueError("lanAllowedDestinations cannot allow every address")
            text = str(network) if "/" in text else str(network.network_address)
        elif text in ("*", "*.*") or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789.*-_" for c in text):
            raise ValueError("lanAllowedDestinations must contain host patterns, IP addresses or CIDR ranges")
        if text not in result:
            result.append(text)
    return result


def destination_allowed(service, host):
    """True when the user allowed LAN devices to reach this host name or address."""
    host = str(host).strip("[]").lower()
    address = _address(host)
    for entry in service.settings.get("lanAllowedDestinations", []):
        if address is not None:
            try:
                if address in ipaddress.ip_network(entry, strict=False):
                    return True
            except ValueError:
                pass
        elif fnmatch.fnmatchcase(host, entry):
            return True
    return False


class LanGuard:
    def __init__(self, service):
        self.service = service
        # Devices refused since launch, by address: shown to the user once, never persisted.
        self.requests = {}
        self.expiry_timer = None

    def close_devices(self, addresses):
        """Close active clients whose approval was removed, including opaque tunnels."""
        master = self.service.master
        proxyserver = master and master.addons.get("proxyserver")
        if not proxyserver:
            return
        for handler in list(proxyserver.connections.values()):
            if client_ip(handler.client) in addresses:
                handler.close_connection(handler.client)

    def schedule_expiry(self):
        if self.expiry_timer:
            self.expiry_timer.cancel()
            self.expiry_timer = None
        if not self.service.settings.get("lanDeviceExpiry", True):
            return
        approvals = self.service.settings.get("lanDeviceApprovals", {})
        if not approvals:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        delay = max(0, min(approvals.values()) + DEVICE_TTL_SECONDS - time.time())
        self.expiry_timer = loop.call_later(delay, self.prune)

    def summary(self):
        self.prune()
        return [{"address": address, **entry} for address, entry in self.requests.items()]

    def prune(self, now=None):
        """Drops approvals older than DEVICE_TTL_SECONDS and keeps settings.lanDeviceApprovals (address -> approval
        time) in step with lanDevices. Nothing expires while settings.lanDeviceExpiry is off. A device approved before expiry existed, or added through settings, starts its
        24 hours when first seen here. Returns the addresses that expired."""
        now = time.time() if now is None else now
        expired_requests = [address for address, entry in self.requests.items()
                            if not entry.get("denied") and now - entry["firstSeen"] >= REQUEST_TTL_SECONDS]
        for address in expired_requests:
            del self.requests[address]
        if expired_requests:
            self.service.changed()
        settings = self.service.settings
        devices = list(settings.get("lanDevices", []))
        stored = settings.get("lanDeviceApprovals")
        stored = stored if isinstance(stored, dict) else {}
        approvals, expired = {}, []
        for address in devices:
            approved = stored.get(address)
            approved = approved if isinstance(approved, (int, float)) and not isinstance(approved, bool) and approved <= now else now
            if settings.get("lanDeviceExpiry", True) and now - approved >= DEVICE_TTL_SECONDS:
                expired.append(address)
            else:
                approvals[address] = approved
        if expired or approvals != settings.get("lanDeviceApprovals"):
            settings["lanDevices"] = [address for address in devices if address in approvals]
            settings["lanDeviceApprovals"] = approvals
            self.service.persist_config()
            self.service.changed()
        if expired:
            self.close_devices(set(expired))
        self.schedule_expiry()
        return expired

    def client_connected(self, client):
        """Returns False after refusing a LAN client that is not an approved device."""
        if not is_lan_client(client):
            return True
        address = client_ip(client)
        self.prune()
        if address in self.service.settings.get("lanDevices", []):
            return True
        entry = self.requests.get(address)
        if entry is None and len(self.requests) >= MAX_REQUESTS:
            # Keep waiting approvals stable under churn; reclaim a denied slot first.
            denied = next((key for key, value in self.requests.items() if value.get("denied")), None)
            if denied is None:
                client.error = DEVICE_REFUSED
                return False
            self.requests.pop(denied)
        entry = entry or {"firstSeen": time.time(), "attempts": 0, "denied": False}
        entry.update(lastSeen=time.time(), attempts=entry["attempts"] + 1)
        self.requests[address] = entry
        client.error = DEVICE_REFUSED
        self.service.changed()
        return False

    def decide(self, address, allow):
        """Approve or refuse a device address; approval persists in lanDevices."""
        address = validate_devices([address])[0]
        self.prune()
        devices = list(self.service.settings.get("lanDevices", []))
        approvals = dict(self.service.settings.get("lanDeviceApprovals", {}))
        if allow:
            self.requests.pop(address, None)
            if address not in devices:
                devices = validate_devices([*devices, address])
            # Allowing again renews its 24 hours.
            approvals[address] = time.time()
        else:
            devices = [item for item in devices if item != address]
            self.close_devices({address})
            entry = self.requests.get(address)
            if entry is not None:
                entry["denied"] = True
            approvals.pop(address, None)
        self.service.settings["lanDeviceApprovals"] = approvals
        self.service.settings["lanDevices"] = devices
        self.service.persist_config()
        self.schedule_expiry()

    def blocked_reason(self, host, addresses, port=None):
        parsed = [_address(value) for value in addresses]
        # The well-known NAT64 prefix embeds an IPv4 address in its last 32 bits.
        # Apply the Mac's hard port boundary to that address too, even if the
        # translated destination was explicitly approved.
        translated = [ipaddress.IPv4Address(int(address) & 0xffffffff) for address in parsed
                      if address is not None and address.version == 6 and address in TRANSLATION_PREFIXES[0]]
        own = str(host).rstrip(".").lower() == "localhost" or any(
            address is not None and is_this_mac(address) for address in [*parsed, *translated])
        # This boundary cannot be overridden by destination approvals.
        if own and (port in (self.service.port, self.service.settings["proxyPort"]) or port not in DEV_SERVER_PORTS):
            return (f"Streamglass blocked a LAN device from reaching {host}:{port}: this Mac's services "
                    "are available only on dev-server ports; proxy and management ports are always blocked.")
        if own and port != 8081 and not (destination_allowed(self.service, host) or any(
                address is not None and is_this_mac(address) and destination_allowed(self.service, str(address))
                for address in [*parsed, *translated])):
            return (f"Streamglass blocked a LAN device from reaching {host}:{port}: "
                    "approve this Mac as a dev-server destination in Settings → Proxy → LAN destinations.")
        for address in parsed:
            if address is None or (own and is_this_mac(address)):
                continue
            if restricted(address) and not (destination_allowed(self.service, host) or destination_allowed(self.service, str(address))):
                target = host if _address(host) == address else f"{host} ({address})"
                return (f"Streamglass blocked a LAN device from reaching {target}: this Mac's own, private and VPN "
                        "addresses need approval in Settings → Proxy → LAN destinations.")
        return None

    async def destination_reason(self, host, port):
        if _address(host) is not None:
            addresses = [host]
        else:
            try:
                infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
            except (OSError, UnicodeError):
                return self.blocked_reason(host, [], port)
            addresses = [info[4][0] for info in infos]
        return self.blocked_reason(host, addresses, port)

    async def check_flow(self, flow):
        """Refuse before connecting, including CONNECT and paused capture."""
        if not is_lan_client(flow.client_conn):
            return True
        self.prune()
        reason = await self.connection_reason(flow.client_conn, flow.request.host, flow.request.port)
        if reason:
            from mitmproxy import http
            flow.response = http.Response.make(403, reason.encode(), {"Content-Type": "text/plain; charset=utf-8"})
            flow.request.stream = False
            flow.metadata["streamglass_passthrough"] = True
            return False
        return True

    async def connection_reason(self, client, host, port):
        address = client_ip(client)
        if address not in self.service.settings["lanDevices"]:
            return DEVICE_REFUSED
        reason = await self.destination_reason(host, port)
        return reason if address in self.service.settings["lanDevices"] else DEVICE_REFUSED

    async def server_connect(self, data):
        if not data.server.address:
            return
        host, port = data.server.address[:2]
        peer = _address(client_ip(data.client))
        if peer is not None and peer.is_loopback and host == "10.0.2.2" and await self.service.android_alias_route(data.client):
            # Only the socket destination changes: URL, Host and TLS SNI stay intact.
            # Shared by HTTP, opaque/inspected CONNECT and WebSocket upgrades.
            data.server.address = ("127.0.0.1", port)
        if not is_lan_client(data.client):
            return
        self.prune()
        if reason := await self.connection_reason(data.client, host, port):
            data.server.error = reason

    def server_connected(self, data):
        """Recheck the actual peer, including approved names, against DNS rebinding."""
        if not is_lan_client(data.client) or not data.server.peername:
            return
        reason = self.blocked_reason(data.server.address[0], [data.server.peername[0]], data.server.address[1])
        if client_ip(data.client) not in self.service.settings["lanDevices"]:
            reason = DEVICE_REFUSED
        if reason:
            data.server.error = reason
            master = self.service.master
            handler = master and master.addons.get("proxyserver").connections.get(data.client.id)
            if handler and data.server in handler.transports:
                handler.close_connection(data.server)
