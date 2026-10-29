# Device setup

Streamglass changes settings after an explicit setup action or when restoring monitoring you previously enabled. Certificate trust uses per-user SSL trust in the login keychain and may request login credentials. Network changes try normal user access first. On permission denial, only a confirmed administrator account can receive the administrator prompt. Standard accounts and accounts whose membership cannot be read receive IT or app-specific setup instructions instead. Streamglass never changes authorization policy or stores administrator passwords. Proxy snapshots persist under the app data directory; Mac monitoring remains enabled across restarts until Disable Mac capture restores the saved settings. Stop Proxy pauses the listener for this session; restarting Streamglass restores the listener while preserving capture pause and rule state. Use Restore proxy on Android before quitting. A failed partial change retains its snapshot for recovery. Only HTTP/HTTPS proxy fields on visited active networks are changed; PAC and bypass lists are left alone. Disable Mac capture restores all saved networks; failed restorations keep their snapshots for another disable attempt. Authenticated macOS proxies require manual setup because their passwords cannot be recovered.

## macOS

On normal quit, Streamglass suspends network monitoring and restores saved HTTP/HTTPS proxy settings on all monitored Mac networks before stopping its listener. It leaves proxy fields changed outside Streamglass alone. This cleanup does not prompt for administrator credentials. Monitoring intent stays enabled so the next launch starts capture again. A warning appears only if restoration fails or another managed device still has saved proxy settings; **Keep Open** resumes monitoring, while **Quit Anyway** may leave that device without connectivity. Disable Mac capture turns off the remembered preference as well as restoring settings. When the proxy listener is stopped (Stop Proxy, or `proxyEnabled:false` through MCP), Streamglass also restores saved proxy settings that still point at it within about 3 seconds, so the Mac does not keep routing traffic to a stopped proxy; monitoring reapplies them when the proxy starts again. A snapshot that originally pointed back to the same Streamglass listener is disabled on quit rather than restoring a dead proxy.

Open **Connect device → This Mac**. Streamglass monitors the active network automatically and follows Wi-Fi/Ethernet connection changes. The status shows the active service. While monitoring is enabled, a five-second route check uses cached service mappings without polling simulator or Android inventory. When routes disagree or a VPN cannot be matched, **Advanced network override** allows an explicit service; clearing it resumes automatic selection. Background changes never open an administrator dialog. After a successful enable, permission failures on later networks retain monitoring intent and saved originals, with an actionable setup error; retry Enable Mac capture or ask IT for system proxy access.

1. Click **Enable Mac capture** to set the active service's HTTP and HTTPS proxies to `127.0.0.1` and the current Streamglass proxy port. The status shows whether that service is routed through Streamglass. Monitoring follows network changes and preserves each visited service’s prior settings.
2. For HTTPS bodies, click **Trust HTTPS certificate**, then add the intended domains to the **TLS allowlist**. Certificate trust does not route traffic and is separate from enabling capture. The trust action adds the public root certificate to your login keychain with user-scoped TLS trust (`security add-trusted-cert` without `-d`). It does not require enabling the root account. Company restrictions may still require IT assistance.
3. Reload the app or page to create new connections. Click **Disable Mac capture** when finished to restore saved proxy settings on every monitored service. If an administrator prompt fails, the snapshot remains available for restoration.

Apps must use the system HTTP/HTTPS proxy. Apps with their own proxy settings, direct connections, or certificate pinning may require additional app configuration. If the proxy was already configured outside Streamglass, there may be no saved settings to restore; manage that configuration in macOS Network settings. To remove trust later, remove the Streamglass certificate in Keychain Access. Installing and running the packaged application does not require Xcode.

## iOS

Open **Connect device → iOS Simulator**. Simulator apps using the system proxy follow the Mac's network proxy; certificate installation alone does not route requests.

1. Select a booted simulator, then click **Prepare simulator capture**. This starts the listener, trusts the public CA for the current Mac user, installs the CA in the selected simulator, and enables the host HTTP/HTTPS proxy. It also affects Mac apps using that network. Full Xcode with `simctl` is required; the simulator is not booted or restarted.
2. Add the intended API domains to the **TLS allowlist**, then reload the simulator app or page. Relaunch that app if it retains earlier proxy settings. Paused recording, bypass rules, direct sockets, or certificate pinning can still prevent inspection. Preparation preserves capture pause.
3. Monitoring is remembered across restarts. Click **Disable Mac capture** to restore saved settings on every monitored network and disable automatic monitoring. Stop Proxy stops the listener for this session.

If preparation fails, the error identifies completed steps; trust may already have been installed. A failed network change preserves its restoration snapshot. Startup does not show an administrator dialog: if restoring the proxy requires approval, Device Setup reports the requirement and an explicit enable action can request it for an administrator account. Standard accounts never receive that administrator prompt. An unavailable network pauses automatic selection without replacing its saved configuration. Stop Proxy remains stopped for the current session even if the active network changes; only explicit Enable/Play or restarting the app starts the listener again. Existing installations migrate monitor intent only when a saved snapshot exists and that service still points to the current Streamglass proxy port.

Use **Refresh simulators and networks** after booting a simulator or changing network connections. If tools cannot be queried or no simulator is booted, setup shows a diagnostic and disables capture preparation. The selected simulator is not restarted automatically. LAN access is not required for simulator capture through the host's loopback proxy.

For a physical device, enable LAN proxy access, connect to the same network, and set the Wi-Fi HTTP proxy to the displayed Mac address and port. The device's first connection is refused until you allow it in Streamglass. Download the public certificate, install its profile under Settings → General → VPN & Device Management, then enable it under General → About → Certificate Trust Settings. Reverse the Wi-Fi proxy change and remove the profile after use. Xcode is not needed for this flow.

## Android

Physical Android devices do not require ADB or USB debugging for Wi-Fi proxy setup. LAN access is off by default for new profiles; turn on Settings → Proxy → Allow devices on the local network (profiles that already saved the setting keep their choice), then approve the phone when its first connection is refused (see [Local network exposure](#local-network-exposure)). Connect the phone and Mac to the same network, and enter the displayed Mac IP address and port in the phone’s Wi-Fi proxy settings. Open `http://mitm.it` on the phone to download the public CA and install it in Android Settings. Disable the phone’s manually configured Wi-Fi proxy when Streamglass is closed; the Mac cannot undo a manual setting on the phone.

**Optional ADB helpers** is collapsed by default for physical devices. Only these automatic actions require installed Android platform-tools and an authorized USB or wireless debugging connection. Actions accept only connected, authorized serials. Install certificate copies the public certificate to Downloads and opens Security Settings; the user selects Install certificate → CA certificate. The app cannot silently grant CA trust. Enable proxy saves existing global HTTP proxy settings before changing them; Restore uses that snapshot. OEM permissions may prevent settings changes. Restore an ADB-configured proxy before quitting; unresolved snapshots still produce a quit warning.

For emulators, use the Android System Proxy, with `10.0.2.2` as the host address. The emulator's separate Extended Controls / `-http-proxy` mechanism is not the recommended TLS debugging route. Physical devices use the Mac LAN address and can also configure their Wi-Fi proxy manually.

Modern Android apps do not trust user-installed CAs by default. Owned debug builds should explicitly add debug-only trust anchors in Network Security Configuration. Independent library pinning or apps ignoring system proxies still require app cooperation. Streamglass does not root devices, modify system CA partitions, or bypass certificate pinning.

The current proxy capture identifies source devices by connection address; it does not identify the originating Mac application. A local proxy sees the socket peer and HTTP data, without a reliable bundle identifier. Reliable application attribution needs a separate native traffic-capture mechanism; guessing from a User-Agent would mislabel many apps.

## Phone setup page, PAC and QR code

While LAN access is enabled (it is off by default), Streamglass runs a small read-only HTTP setup site on the proxy port plus one (for example `9091` for proxy `9090`). It skips ports that dev servers commonly use, such as Metro's 8081, so proxy `8080` gets setup port `8082`. Set `STREAMGLASS_SETUP_PORT` to choose another port. It starts only while LAN access is on and stops when it is turned off or the app quits. If the port is in use, Connect device shows the error instead of the QR code.

**Connect device** shows a QR code for `http://<mac-lan-ip>:<setup-port>/` for iOS devices, Android devices and emulators. Scan it with the phone camera to open a mobile page with the proxy host and port, numbered iOS and Android steps, and certificate downloads. If LAN access is off, the dialog offers a button to turn it on. The page is reachable only from the local network and needs no proxy to be set first, unlike `http://mitm.it`. It answers only requests whose `Host` header is one of the Mac's own LAN IPv4 addresses (optionally with the setup port); any other host name gets HTTP 421, which defends against DNS-rebinding pages. The page and the QR section of Connect device show the CA certificate's SHA-256 fingerprint. Compare the two before trusting the certificate on a device.

| Path | Content |
| --- | --- |
| `/` | Setup instructions with the proxy address |
| `/cert.crt`, `/cert.pem` | Public CA certificate (DER with `application/x-x509-ca-cert`, PEM) |
| `/streamglass.mobileconfig` | Unsigned iOS profile containing only the CA certificate payload |
| `/proxy.pac` | PAC file returning `PROXY <mac-lan-ip>:<proxy-port>; DIRECT` |

For **Auto proxy**, enter the PAC URL (`http://<mac-lan-ip>:<setup-port>/proxy.pac`) in the Wi-Fi proxy settings (iOS: Configure Proxy, Automatic; Android: Proxy Auto-Config). The PAC URL is shown in the dialog with a copy button. The profile is unsigned, so iOS marks it as not verified; this is expected. Remove the profile and proxy setting when you finish.

### adb reverse and React Native

For an Android emulator or a USB-attached device, **Reverse ports** in Connect device runs `adb -s <serial> reverse tcp:<proxy-port> tcp:<proxy-port>` for an authorized device only. Tick **Also reverse Metro (8081)** to add `tcp:8081`. **Remove reverse** deletes the same forwardings. Reversals end when the device disconnects or adb restarts.

React Native: Metro uses `localhost:8081`, so reverse it for the app to reach your Mac. When using adb reverse, set the device proxy to `127.0.0.1:<proxy-port>`. Without it, use the Mac LAN address (physical device) or `10.0.2.2` (emulator).

## Boundaries

CA installation and proxy routing are separate prerequisites. Successful configuration does not prove that an app accepts the CA or uses the proxy. Only public CA material is transferred. LAN proxy access must be enabled explicitly; management APIs remain local. See [simulator system proxy setup](https://www.charlesproxy.com/documentation/configuration/browser-and-system-configuration/), [Apple trust](https://support.apple.com/en-ph/102390), [Xcode tooling](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference), [Android proxy](https://developer.android.com/studio/run/emulator-networking-proxy), and [Android CA configuration](https://developer.android.com/privacy-and-security/security-config).

Apple documents [user trust authentication](https://developer.apple.com/documentation/security/sectrustsettingssettrustsettings(_:_:_:)) and [networksetup](https://support.apple.com/en-lamr/guide/remote-desktop/apdd0c5a2d5/mac). Network proxy administration cannot be guaranteed password-free on a managed Mac; ask an administrator or configure the proxies manually in Network settings when access is denied.

For an office Mac with no administrator access, expand **Certificate-only setup for a managed Mac** and click **Install certificates only**. This trusts the CA for the current Mac user and the selected simulator without changing network settings or starting the listener. User trust may still request your normal login authentication or be restricted by company policy. Configure `127.0.0.1:<proxy port>` inside the app when it supports its own HTTP/HTTPS proxy, or ask IT to configure the network service. Start the Streamglass proxy before sending traffic. There is no supported promise of system-wide capture from a standard account without network configuration permission.

### Standard accounts on managed Macs

Streamglass does not require administrator rights to run. Certificate setup targets the current user trust domain and login keychain; organizational policy may still restrict trust changes. macOS system HTTP/HTTPS proxy changes can require administrator approval. Streamglass does not bypass those restrictions or repeatedly show an admin prompt for standard accounts.

Where your organization allows it, apps with independent proxy settings can point to `127.0.0.1` and the Streamglass proxy port without changing the system proxy. For example, [Firefox supports manual proxy settings](https://support.mozilla.org/en-US/kb/connection-settings-firefox). This captures that app only, not all Mac or simulator traffic. For system-wide or simulator capture, ask IT to configure the host proxy when your account cannot do so.

## Local network exposure

LAN access is off by default for new profiles: the proxy listens on `127.0.0.1` only. Profiles that already saved the setting keep it. Turning on **Allow devices on the local network** in Settings → Proxy makes the proxy listen on all interfaces, so use it only on trusted networks and turn it off after use. The management API and MCP server remain loopback-only and token-protected.

**Device approval.** While LAN access is on, a proxy client that is not on this Mac must be an approved device. An unknown device's connection is refused and it appears as a request, with a banner in the main window offering **Allow device** or **Deny**. Allowed devices are saved by IP address in the profile (`lanDevices`). Settings → Proxy lists them with remove buttons, and lists devices refused since launch with an **Allow** button. At most 32 requests are kept, and they are not saved across restarts. Loopback clients are never restricted: this Mac, iOS simulators, the Android emulator through `10.0.2.2`, and `adb reverse`. Approval is by IP address, so another device that takes over the same address on the network inherits it.

**Destination guard.** An approved LAN device cannot use the Mac as a way into other networks. It cannot reach non-global addresses: this Mac's own services on loopback and its LAN address, private (RFC 1918) ranges, link-local addresses including the 169.254.169.254 metadata address, carrier-grade NAT (100.64.0.0/10), IPv6 unique-local and link-local addresses, and multicast and reserved ranges. This also covers typical VPN-routed internal networks. Host names are resolved and every resolved address is checked, and the address actually connected is checked again after the connection opens, which stops DNS rebinding. A blocked connection fails with a message naming the host and address. To allow specific destinations, add host wildcard patterns, IP addresses or CIDR ranges (one per line, at most 100) under Settings → Proxy → **LAN destinations** (`lanAllowedDestinations`). `*`, `*.*` and `/0` are rejected. Internal services reachable on public (global) IP addresses through a VPN are not detected.

## TLS handshake failures

If a host in the TLS allowlist shows a "TLS handshake failed" badge, the device rejected the Streamglass certificate. On iOS this most often means the profile is installed but full trust (Settings → General → About → Certificate Trust Settings) is still off. Open the row's Overview for the likely cause. iOS needs the profile installed and full trust enabled in Settings, General, About, Certificate Trust Settings. Android 7+ apps ignore user CAs unless debug builds use a network security config with `<certificates src="user"/>`. React Native follows the native platform; disable OkHttp CertificatePinner, TrustKit, or react-native-ssl-pinning in debug. For pinned apps, disable pinning in debug builds or remove the host from the TLS allowlist to pass through.

An allowlisted host can also stay as an encrypted CONNECT row with no requests: the client completed TLS with the Streamglass certificate and then closed the connection. Streamglass flags this as "closed after handshake". It usually means pinning checked after the handshake (for example OkHttp `CertificatePinner` on Android or React Native), and occasionally an unused pre-connection. Disable pinning in debug builds for that host.

## Proxy port already in use

Streamglass listens on port 9090 by default, the same port Proxyman uses. If another app holds the port, Streamglass still opens, the proxy stays stopped, and a banner explains the conflict with a **Change port** button (Settings → Proxy). Check which app holds the port with `lsof -nP -iTCP:9090 -sTCP:LISTEN`.
