# Device setup

Streamglass changes settings after an explicit setup action or when restoring monitoring you previously enabled. Certificate trust uses per-user SSL trust in the login keychain and may request login credentials. Network changes try normal user access first. On permission denial, only a confirmed administrator account can receive the administrator prompt. Standard accounts and accounts whose membership cannot be read receive IT or app-specific setup instructions instead. Streamglass never changes authorization policy or stores administrator passwords. Proxy snapshots persist under the app data directory; Mac monitoring remains enabled across restarts until **Disable capture** restores the saved settings. Stop Proxy pauses the listener for this session; restarting Streamglass restores the listener while preserving capture pause and rule state. Use Revert to restore device settings when finished. A failed partial change retains its snapshot for recovery. Only HTTP/HTTPS proxy fields on visited active networks are changed; PAC and bypass lists are left alone. **Disable capture** restores all saved networks; failed restorations keep their snapshots for another disable attempt. Authenticated macOS proxies require manual setup because their passwords cannot be recovered.

## macOS

Open **Connect a device → This Mac** and select **Enable capture**. The **Mac capture** row shows the proxy configured for the active or applied network service and whether Mac monitoring is on. **Traffic** reports captures attributed to Mac apps and processes since opening the page. For a VPN or a specific network service, open **Network**, choose the service, and select **Apply network** if capture is already enabled. **Troubleshooting** includes the local address for apps with their own proxy settings.

**HTTPS inspection** matches the active Streamglass CA by SHA-256 fingerprint in the macOS keychains and checks it using macOS SSL trust settings. Select **Install and trust** if the CA is missing or **Trust certificate** if it needs trust. Add the intended domains in **TLS allowlist**, then reload the app or page.

On normal quit, Streamglass suspends network monitoring and restores saved HTTP/HTTPS proxy settings on all monitored Mac networks before stopping its listener. It leaves proxy fields changed outside Streamglass alone. This cleanup does not prompt for administrator credentials. Monitoring intent stays enabled so the next launch starts capture again. Quit warnings distinguish Mac restoration from Android cleanup. Legacy Android restore records and records for unavailable devices stay available for **Revert all proxies** without interrupting quit. **Keep Open** resumes monitoring. Select **Disable capture** when finished to restore saved proxy settings on every monitored service. If an administrator prompt fails, the snapshot remains available for restoration.

Apps must use the system HTTP/HTTPS proxy. Apps with their own proxy settings, direct connections, or certificate pinning may require additional app configuration. If the proxy was already configured outside Streamglass, there may be no saved settings to restore; manage that configuration in macOS Network settings. To remove trust later, remove the Streamglass certificate in Keychain Access. Installing and running the packaged application does not require Xcode.

## iOS and Android

Open **Connect a device** (it opens in its own window) and choose **This Mac**, **iOS**, or **Android**. iOS and Android open on **Real device**, followed by **Simulator** or **Emulator**. Explicit simulator and emulator menu links open those pages directly.

### Real device

This Wi-Fi flow works for QA and anyone without developer options. Connect the phone and Mac to the same network, turn on local network access in the window, and enter the displayed Mac LAN address and proxy port in the phone's manual Wi-Fi proxy settings. Allow the phone in the inline device approval list when its first connection is refused. Scan the QR code to open the certificate setup page and install the public certificate. Open **Setup details** next to the QR code to compare the SHA-256 fingerprint before trusting it.

On iOS, install the downloaded profile in Settings → General → VPN & Device Management, then enable full trust in Settings → General → About → Certificate Trust Settings. On Android, install the downloaded CA in Settings → Security → Encryption & credentials → Install a certificate → CA certificate; menu names may vary.

Add the intended domains to the TLS allowlist and open the app. Each time you open the window, Android and iOS start verification when you first visit their platform. Only new captures can mark HTTPS, traffic or Metro as verified. Connected devices still show **Revert**. An inspected HTTPS response from the selected device verifies certificate trust even before manual confirmation. Plain HTTP and opaque CONNECT tunnels do not verify trust. A later handshake failure remains visible for troubleshooting. When finished, turn the manual Wi-Fi proxy off on the phone; Streamglass cannot revert it.

Android apps must trust user-installed CAs. For a debuggable `com.example.app` build, reference a network security configuration from the manifest and add a user trust anchor in `debug-overrides`. These overrides apply only to debuggable builds. A non-debuggable QA or staging variant needs the user trust anchor in that variant's network security configuration. Apps that ignore system proxies or pin certificates need additional app configuration.

### Android developer shortcuts

Expand **Developer shortcuts** for an authorized USB phone or wireless debugging. Android 11 and later can pair through the phone’s Wireless debugging settings. Select **Prepare certificate** to copy the public CA and open Security settings. Set the proxy for the current Wi-Fi network using the guide above. USB and wireless ADB assist with certificate setup, and USB can also set up a Metro tunnel. Physical-phone setup leaves Android’s global proxy untouched.

### Android Emulator

On **Android → Emulator**, select **Connect** for an online emulator, or **Connect all**. Streamglass saves the existing global proxy settings, sets the proxy to `10.0.2.2:<proxy-port>`, and installs the public CA. LAN access is not needed. Rootable images, commonly Google APIs images, receive a temporary system CA; start a new app process to use it. Apps that use Android's trust store accept it; browsers with their own root store, such as recent Chrome, may still reject it, so verify HTTPS in your app. Reboot clears this trust, and the reapply option restores it when the emulator reconnects. Google Play images use a user CA: Streamglass copies `streamglass-ca-<hash>.crt` to Downloads and opens Security settings; choose Encryption & credentials → Install a certificate → CA certificate, pick the file, then select **I installed it**. The app must trust user CAs as described above. Rootability and installation depend on the image and adb permissions.

### iOS Simulator

On **iOS → Simulator**, select **Connect** for a booted simulator, or **Connect all**. Streamglass installs the public root certificate with `simctl` and enables this Mac's proxy, which also affects Mac apps using that network. Full Xcode and a booted simulator are required; Streamglass does not boot or restart it. Add intended domains to the TLS allowlist and reload the app. Revert restores the Mac proxy when Streamglass owns it and no other connected simulator needs it; the simulator certificate remains installed.

### React Native and Metro

Under **Options**, set React Native / Metro to **Auto**, **Always**, or **Off**. Auto (default) uses `http://127.0.0.1:8081/status` to detect `packager-status:running`. The manual Wi-Fi Metro step appears only while Metro is running. Always can show Metro on automated setup cards while it is stopped. Off hides all Metro steps. A status response does not prove the bundle rendered.

For an emulator, the proxy is `10.0.2.2:<proxy-port>`. An attributed Android emulator request through the proxy to `10.0.2.2:8081` is routed to Metro on this Mac; direct `localhost:8081` requests use an adb reverse when Metro is enabled. USB uses adb reverse as well. Wi-Fi phones can reach Metro through the proxy using `localhost:8081` or the Mac LAN address on port 8081, subject to device approval and the dev-server port allowlist below. iOS development builds may embed the Mac LAN address. If an Android app skips its proxy for localhost, use the React Native Dev Menu → Change bundle location and enter the Mac LAN address and port 8081.

### Options and Revert

**Re-apply when an emulator restarts or adb reconnects** is on by default for previously connected emulators and USB devices. **Revert proxies set by Streamglass when it quits** is also on by default. **Connect new emulators and simulators automatically** is off by default.

**Revert all proxies** restores saved Mac and managed Android proxy settings in one action. **Revert** beside an Android device restores that device’s settings, including global settings saved by older versions. After switching networks, connect the phone by USB and retry. Streamglass keeps the restore record if the device is unavailable or Android still has a stale proxy cached. If Android reports a cached proxy after the saved values were cleared, restart the phone. Streamglass preserves independently changed proxies and installed certificates. Turn off any Wi-Fi proxy you entered manually in the phone’s Wi-Fi settings.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| White screen | Check the bundle request and app JavaScript errors. A running Metro status alone does not prove the app rendered or that the proxy failed. |
| HTTPS bodies missing | Install and trust the CA, allowlist the domain, and reconnect. Check Android user-CA configuration and certificate pinning. |
| Device lost internet | Select **Revert** for an automated setup, or turn off the phone's manual Wi-Fi proxy. |
| Live checks remain pending | Resume capture and make a new request; proxy settings and certificate installation alone do not prove app traffic. |

## Phone setup page, PAC and QR code

While LAN access is enabled (it is off by default), Streamglass runs a small read-only HTTP setup site on the proxy port plus one (for example `9091` for proxy `9090`). It skips ports that dev servers commonly use, such as Metro's 8081, so proxy `8080` gets setup port `8082`. Set `STREAMGLASS_SETUP_PORT` to choose another port. It starts only while LAN access is on and stops when it is turned off or the app quits. If the port is in use, Connect device shows the error instead of the QR code.

**Connect device** shows a QR code for `http://<mac-lan-ip>:<setup-port>/` on the real-device pages for iOS and Android. Scan it with the phone camera to open a mobile page with the proxy host and port, numbered iOS and Android steps, and certificate downloads. If LAN access is off, the window offers a button to turn it on. The page is reachable only from the local network and needs no proxy to be set first, unlike `http://mitm.it`. It answers only requests whose `Host` header is one of the Mac's own LAN IPv4 addresses (optionally with the setup port); any other host name gets HTTP 421, which defends against DNS-rebinding pages. The page and **Setup details** next to the QR code show the CA certificate's SHA-256 fingerprint. Compare the two before trusting the certificate on a device.

| Path | Content |
| --- | --- |
| `/` | Setup instructions with the proxy address |
| `/cert.crt`, `/cert.pem` | Public CA certificate (DER with `application/x-x509-ca-cert`, PEM) |
| `/streamglass.mobileconfig` | Unsigned iOS profile containing only the CA certificate payload |
| `/proxy.pac` | PAC file returning `PROXY <mac-lan-ip>:<proxy-port>; DIRECT` |

For **Auto proxy**, enter the PAC URL (`http://<mac-lan-ip>:<setup-port>/proxy.pac`) in the Wi-Fi proxy settings (iOS: Configure Proxy, Automatic; Android: Proxy Auto-Config). The PAC URL is shown in the window with a copy button. The profile is unsigned, so iOS marks it as not verified; this is expected. Remove the profile and proxy setting when you finish.

### adb reverse and React Native

Streamglass creates the needed adb reverses during Connect and removes its own reverses during Revert. Reversals end when the device disconnects or adb restarts.

React Native: reverse Metro port 8081 when the app connects directly to `localhost:8081`. When using adb reverse for the proxy, set the device proxy to `127.0.0.1:<proxy-port>`. Otherwise use the Mac LAN address (physical device) or `10.0.2.2:<proxy-port>` (emulator). When an attributed Android emulator requests Metro at `http://10.0.2.2:8081`, the engine routes the upstream socket to `127.0.0.1:8081` on this Mac, including WebSocket/HMR connections, while captures and Host headers retain `10.0.2.2`. Other clients keep the original destination.

## Boundaries

CA installation and proxy routing are separate prerequisites. Successful configuration does not prove that an app accepts the CA or uses the proxy. Only public CA material is transferred. LAN proxy access must be enabled explicitly; management APIs remain local. See [simulator system proxy setup](https://www.charlesproxy.com/documentation/configuration/browser-and-system-configuration/), [Apple trust](https://support.apple.com/en-ph/102390), [Xcode tooling](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference), [Android proxy](https://developer.android.com/studio/run/emulator-networking-proxy), and [Android CA configuration](https://developer.android.com/privacy-and-security/security-config).

Apple documents [user trust authentication](https://developer.apple.com/documentation/security/sectrustsettingssettrustsettings(_:_:_:)) and [networksetup](https://support.apple.com/en-lamr/guide/remote-desktop/apdd0c5a2d5/mac). Network proxy administration cannot be guaranteed password-free on a managed Mac; ask an administrator or configure the proxies manually in Network settings when access is denied.

On a managed Mac without network proxy permission, configure `127.0.0.1:<proxy port>` inside an app that supports its own HTTP/HTTPS proxy, or ask IT to configure the network service. Start the Streamglass proxy before sending traffic.

### Standard accounts on managed Macs

Streamglass does not require administrator rights to run. Certificate setup targets the current user trust domain and login keychain; organizational policy may still restrict trust changes. macOS system HTTP/HTTPS proxy changes can require administrator approval. Streamglass does not bypass those restrictions or repeatedly show an admin prompt for standard accounts.

Where your organization allows it, apps with independent proxy settings can point to `127.0.0.1` and the Streamglass proxy port without changing the system proxy. For example, [Firefox supports manual proxy settings](https://support.mozilla.org/en-US/kb/connection-settings-firefox). This captures that app only, not all Mac or simulator traffic. For system-wide or simulator capture, ask IT to configure the host proxy when your account cannot do so.

## Local network exposure

LAN access is off by default for new profiles: the proxy listens on `127.0.0.1` only. Profiles that already saved the setting keep it. Turning on **Allow devices on the local network** in Settings → Proxy makes the proxy listen on all interfaces, so use it only on trusted networks and turn it off after use. The management API and MCP server remain loopback-only and token-protected.

**Device approval.** While LAN access is on, a proxy client that is not on this Mac must be an approved device. An unknown device's connection is refused and it appears as a request: a **Device approval** popup in the main window offers **Deny** (default, also Esc) or **Allow device**, one device at a time. While Connect a device is open the popup is held back: the real-device guide lists approved, waiting and refused devices with inline approval controls. Allowed devices are saved by IP address in the profile (`lanDevices`) and forgotten 24 hours after approval, because shared networks reassign addresses; Settings → Proxy shows the time left for each and has a **Forget approved devices after 24 hours** switch (on by default). Allowing a device again renews it. Settings → Proxy lists them with remove buttons, and lists devices refused since launch with an **Allow** button. At most 32 requests are kept. Waiting entries expire after five minutes, and requests are local to the current session. Loopback clients are never restricted: this Mac, iOS simulators, the Android emulator through `10.0.2.2`, and `adb reverse`. Approval is by IP address, so another device that takes over the same address on the network inherits it.

Confirm the IP address on the device before allowing it; network names are unverified and can be misleading. When the request list is full, existing waiting requests remain in place and new addresses are refused until space is available. Removing an approval or reaching its expiry closes that device's active proxy connections.

**Dev servers on this Mac.** Approved LAN clients may reach localhost, loopback addresses or the Mac's own interface addresses only on ports 3000, 3001, 4200, 5000, 5173, 7000, 8000, 8080, 8081 (Metro), 8888, 19000, 19001, 19002 and 19006. Metro on 8081 is available after device approval. Other ports in this list also require an explicit Mac destination approval in Settings → Proxy → LAN destinations. The proxy's own port and management API port are always blocked. Other ports return an explanatory HTTP 403 (including CONNECT requests). Loopback clients are unrestricted. This policy and emulator alias routing continue while capture is paused.

**Destination guard.** An approved LAN device cannot use the Mac as a way into other networks. Apart from the dev-server exception above, it cannot reach non-global addresses: this Mac's own services on loopback and its LAN address, private (RFC 1918) ranges, link-local addresses including the 169.254.169.254 metadata address, carrier-grade NAT (100.64.0.0/10), IPv6 unique-local and link-local addresses, and multicast and reserved ranges. This also covers typical VPN-routed internal networks. Host names are resolved and every resolved address is checked, and the address actually connected is checked again after the connection opens, which stops DNS rebinding. A blocked connection fails with a message naming the host and address. To allow specific destinations, add host wildcard patterns, IP addresses or CIDR ranges (one per line, at most 100) under Settings → Proxy → **LAN destinations** (`lanAllowedDestinations`). `*`, `*.*` and `/0` are rejected. Internal services reachable on public (global) IP addresses through a VPN are not detected.

The destination guard also restricts deprecated IPv6 site-local addresses and the well-known and local-use NAT64 prefixes. Explicit destination approvals remain available for these ranges, subject to the hard boundary for this Mac's own services.

## TLS handshake failures

If a host in the TLS allowlist shows a "TLS handshake failed" badge, the device rejected the Streamglass certificate. On iOS this most often means the profile is installed but full trust (Settings → General → About → Certificate Trust Settings) is still off. Open the row's Overview for the likely cause. iOS needs the profile installed and full trust enabled in Settings, General, About, Certificate Trust Settings. Android apps need a network security configuration with `<certificates src="user"/>`; `debug-overrides` applies only to debuggable builds, so non-debuggable variants need their own trust configuration. React Native follows the native platform; disable OkHttp CertificatePinner, TrustKit, or react-native-ssl-pinning in debug. For pinned apps, disable pinning in debug builds or remove the host from the TLS allowlist to pass through.

An allowlisted host can also stay as an encrypted CONNECT row with no requests: the client completed TLS with the Streamglass certificate and then closed the connection. Streamglass flags this as "closed after handshake". It usually means pinning checked after the handshake (for example OkHttp `CertificatePinner` on Android or React Native), and occasionally an unused pre-connection. Disable pinning in debug builds for that host.

## Proxy port already in use

Streamglass listens on port 9090 by default, the same port Proxyman uses. If another app holds the port, Streamglass still opens, the proxy stays stopped, and a banner explains the conflict with a **Change port** button (Settings → Proxy). Check which app holds the port with `lsof -nP -iTCP:9090 -sTCP:LISTEN`.
