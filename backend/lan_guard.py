"""LAN access controls. While LAN access is on, a proxy client that is not this Mac must be an approved device, and an
approved device cannot reach this Mac's own services or private, link-local and VPN-routed (non-global) addresses
unless the user allows that destination. Loopback clients (this Mac, simulators, adb reverse) are not restricted."""
import asyncio
import fnmatch
import ipaddress
import socket
import time

MAX_DEVICES = 64
MAX_DESTINATIONS = 100
MAX_REQUESTS = 32
# An approval lasts this long from the moment it is given. Addresses on shared networks are reassigned, so an old
# approval would otherwise pass to whichever device takes over the address.
DEVICE_TTL_SECONDS = 7 * 24 * 60 * 60
DEVICE_REFUSED = "Device is not approved to use this proxy. Approve it in Streamglass."


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


def restricted(address):
    """Loopback, private, link-local, shared (CGNAT), reserved and multicast addresses are not public destinations."""
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

    def summary(self):
        self.prune()
        return [{"address": address, **entry} for address, entry in self.requests.items()]

    def prune(self, now=None):
        """Drops approvals older than DEVICE_TTL_SECONDS and keeps settings.lanDeviceApprovals (address -> approval
        time) in step with lanDevices. Nothing expires while settings.lanDeviceExpiry is off. A device approved before expiry existed, or added through settings, starts its
        seven days when first seen here. Returns the addresses that expired."""
        now = time.time() if now is None else now
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
        return expired

    def client_connected(self, client):
        """Returns False after refusing a LAN client that is not an approved device."""
        if not is_lan_client(client):
            return True
        address = client_ip(client)
        self.prune()
        if address in self.service.settings.get("lanDevices", []):
            return True
        entry = self.requests.pop(address, None) or {"firstSeen": time.time(), "attempts": 0, "denied": False}
        entry.update(lastSeen=time.time(), attempts=entry["attempts"] + 1)
        self.requests[address] = entry
        while len(self.requests) > MAX_REQUESTS:
            self.requests.pop(next(iter(self.requests)))
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
            # Allowing again renews the seven days.
            approvals[address] = time.time()
        else:
            devices = [item for item in devices if item != address]
            entry = self.requests.setdefault(address, {"firstSeen": time.time(), "lastSeen": time.time(), "attempts": 0})
            entry["denied"] = True
            approvals.pop(address, None)
        self.service.settings["lanDeviceApprovals"] = approvals
        self.service.settings["lanDevices"] = devices
        self.service.persist_config()

    def blocked_reason(self, host, addresses):
        if destination_allowed(self.service, host):
            return None
        for value in addresses:
            address = _address(value)
            if address is not None and restricted(address) and not destination_allowed(self.service, str(address)):
                target = host if _address(host) == address else f"{host} ({address})"
                return (f"Streamglass blocked a LAN device from reaching {target}: this Mac's own, private and VPN "
                        "addresses need approval in Settings → Proxy → LAN destinations.")
        return None

    async def server_connect(self, data):
        if not is_lan_client(data.client) or not data.server.address:
            return
        host, port = data.server.address[:2]
        if destination_allowed(self.service, host):
            return
        if _address(host) is not None:
            addresses = [host]
        else:
            try:
                infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
            except (OSError, UnicodeError):
                return  # mitmproxy reports the resolution failure itself
            addresses = [info[4][0] for info in infos]
        if reason := self.blocked_reason(host, addresses):
            data.server.error = reason

    def server_connected(self, data):
        """Checks the address actually connected, so a name that re-resolves after server_connect is still refused."""
        if not is_lan_client(data.client) or not data.server.peername:
            return
        if reason := self.blocked_reason(data.server.address[0], [data.server.peername[0]]):
            data.server.error = reason
            master = self.service.master
            handler = master and master.addons.get("proxyserver").connections.get(data.client.id)
            if handler and data.server in handler.transports:
                handler.close_connection(data.server)
