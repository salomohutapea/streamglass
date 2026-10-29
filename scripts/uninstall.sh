#!/bin/bash
# Remove Streamglass from this Mac user: quit the app, restore the network proxy settings it changed, remove the
# trust and copy of its certificate authority (CA) from the login keychain, delete its saved data, including the CA
# private key, captures, rules and the MCP token, and delete the app.
# Run it as the Mac user who used Streamglass (not as root); it asks for an administrator password only when macOS
# requires one for network settings or for /Applications.
#   --keep-app        keep Streamglass.app, remove everything else
#   --yes             do not ask for confirmation
#   STREAMGLASS_DATA_DIR=...   a non-default data folder to remove instead
set -uo pipefail

keep_app=""
assume_yes=""
for arg in "$@"; do
  case "$arg" in
    --keep-app) keep_app=1 ;;
    --yes) assume_yes=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script removes Streamglass from macOS." >&2
  exit 1
fi
if [ "$(id -u)" = "0" ]; then
  echo "Run this script as the Mac user who used Streamglass, not as root. It needs that user's login keychain." >&2
  exit 1
fi

data="${STREAMGLASS_DATA_DIR:-$HOME/Library/Application Support/Streamglass}"
ca="$data/mitmproxy/mitmproxy-ca-cert.pem"
keychain="$HOME/Library/Keychains/login.keychain-db"
problems=0
warn() { echo "  ! $*" >&2; problems=$((problems + 1)); }

echo "This removes Streamglass for $(id -un):"
echo "  - restores network proxy settings Streamglass changed"
echo "  - removes the Streamglass CA certificate and its trust from the login keychain"
echo "  - deletes $data (captures, rules, CA private key, MCP token)"
[ -z "$keep_app" ] && echo "  - deletes Streamglass.app"
if [ -z "$assume_yes" ]; then
  if ! { : </dev/tty; } 2>/dev/null; then
    echo "No terminal to confirm on. Rerun with --yes." >&2
    exit 1
  fi
  printf "Continue? [y/N] "
  read -r answer </dev/tty || answer=""
  case "$answer" in y|Y|yes|YES) ;; *) echo "Nothing was changed."; exit 0 ;; esac
fi

# 1. Quit the app. On quit it restores the Mac proxy itself; the steps below cover a crash or a forced quit.
if pgrep -xq Streamglass; then
  echo "Quitting Streamglass..."
  osascript -e 'quit app "Streamglass"' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do pgrep -xq Streamglass || break; sleep 0.5; done
  if pgrep -xq Streamglass; then
    echo "Streamglass is still running. Quit it (choose Quit Anyway if asked) and run this script again." >&2
    exit 1
  fi
fi

# 2. Network proxy settings.
networksetup_run() {
  /usr/sbin/networksetup "$@" >/dev/null 2>&1 && return 0
  sudo /usr/sbin/networksetup "$@" >/dev/null
}
proxy_port=9090
if [ -f "$data/captures.sqlite3" ] && command -v sqlite3 >/dev/null; then
  port="$(sqlite3 -readonly "$data/captures.sqlite3" "SELECT json_extract(value, '\$.proxyPort') FROM config WHERE key='settings'" 2>/dev/null || true)"
  case "$port" in ''|*[!0-9]*) ;; *) proxy_port="$port" ;; esac
fi
state="$data/device-proxy-state.json"
if [ -f "$state" ]; then
  echo "Restoring saved Mac proxy settings..."
  # Lines of: service<TAB>web|secureweb<TAB>on|off<TAB>host<TAB>port
  saved="$(osascript -l JavaScript -e '
    ObjC.import("Foundation");
    function run(argv) {
      const text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js;
      const lines = [];
      for (const [key, types] of Object.entries(JSON.parse(text))) {
        if (!key.startsWith("mac:")) continue;
        for (const [type, saved] of Object.entries(types)) lines.push([key.slice(4), type, saved.enabled ? "on" : "off", saved.host || "", saved.port || ""].join("\t"));
      }
      return lines.join("\n");
    }' "$state" 2>/dev/null || true)"
  while IFS=$'\t' read -r service type enabled host port; do
    [ -n "$service" ] || continue
    case "$type" in web|secureweb) ;; *) continue ;; esac
    # A saved snapshot that itself pointed at this proxy would leave a dead proxy behind.
    if [ "$host" = "127.0.0.1" ] && [ "$port" = "$proxy_port" ]; then enabled=off; fi
    if [ -n "$host" ] && [ -n "$port" ]; then networksetup_run "-set${type}proxy" "$service" "$host" "$port" || warn "Could not restore the $type proxy host of $service"; fi
    networksetup_run "-set${type}proxystate" "$service" "$enabled" || warn "Could not restore the $type proxy of $service"
  done <<< "$saved"
  grep -q '"android:' "$state" 2>/dev/null && warn "Android devices were routed through Streamglass. On each device, clear the Wi-Fi proxy or run: adb shell settings put global http_proxy :0"
fi
# Any network service still pointing at this proxy is switched off, even without saved state.
while IFS= read -r service; do
  case "$service" in ''|"An asterisk"*) continue ;; esac
  service="${service#\*}"
  for type in web secureweb; do
    current="$(/usr/sbin/networksetup "-get${type}proxy" "$service" 2>/dev/null || true)"
    if printf '%s\n' "$current" | grep -q '^Enabled: Yes$' && printf '%s\n' "$current" | grep -q '^Server: 127\.0\.0\.1$' \
       && printf '%s\n' "$current" | grep -q "^Port: ${proxy_port}\$"; then
      echo "Turning off the $type proxy of $service (it pointed at Streamglass)..."
      networksetup_run "-set${type}proxystate" "$service" off || warn "Could not turn off the $type proxy of $service"
    fi
  done
done <<< "$(/usr/sbin/networksetup -listallnetworkservices 2>/dev/null)"

# 3. CA certificate and trust, matched by this installation's certificate only.
if [ -f "$ca" ]; then
  sha1="$(openssl x509 -in "$ca" -noout -fingerprint -sha1 2>/dev/null | sed 's/.*=//; s/://g')"
  if [ -n "$sha1" ]; then
    echo "Removing the Streamglass CA ($sha1) from the login keychain..."
    security remove-trusted-cert "$ca" >/dev/null 2>&1 || true
    if security find-certificate -a -Z "$keychain" 2>/dev/null | grep -qi "SHA-1 hash: $sha1"; then
      security delete-certificate -Z "$sha1" "$keychain" >/dev/null 2>&1 || warn "Could not delete the Streamglass CA from the login keychain. Delete the certificate named mitmproxy with SHA-1 $sha1 in Keychain Access."
    fi
    if security find-certificate -a -Z /Library/Keychains/System.keychain 2>/dev/null | grep -qi "SHA-1 hash: $sha1"; then
      warn "The Streamglass CA is also in the System keychain. An administrator can remove it with: sudo security delete-certificate -Z $sha1 /Library/Keychains/System.keychain"
    fi
  else
    warn "Could not read $ca. Remove any certificate named mitmproxy that you trusted for Streamglass in Keychain Access."
  fi
else
  echo "No Streamglass CA found in $data; skipping keychain cleanup."
fi
echo "  Phones, tablets and simulators keep their own copy of the CA. Remove the Streamglass profile or certificate on each device."

# 4. Saved data. The CA private key, captures, rules, scripts, workspaces and the MCP token live here.
if [ -d "$data" ]; then
  echo "Deleting $data..."
  rm -rf "$data" || warn "Could not delete $data"
fi
for leftover in "$HOME/Library/Preferences/dev.streamglass.desktop.plist" "$HOME/Library/Saved Application State/dev.streamglass.desktop.savedState" \
                "$HOME/Library/Caches/dev.streamglass.desktop" "$HOME/Library/Caches/dev.streamglass.desktop.ShipIt" "$HOME/Library/Logs/Streamglass"; do
  [ -e "$leftover" ] && { rm -rf "$leftover" || warn "Could not delete $leftover"; }
done
echo "  AI clients configured with the Streamglass MCP address and token keep that entry; remove it from their settings."

# 5. The app.
if [ -z "$keep_app" ]; then
  for app in "/Applications/Streamglass.app" "$HOME/Applications/Streamglass.app"; do
    [ -d "$app" ] || continue
    echo "Deleting $app..."
    if [ -w "$(dirname "$app")" ] && [ -w "$app" ]; then rm -rf "$app" || warn "Could not delete $app"
    else sudo rm -rf "$app" || warn "Could not delete $app"; fi
  done
fi

if [ "$problems" -gt 0 ]; then
  echo "Streamglass was removed with $problems item(s) that need attention (listed above)." >&2
  exit 1
fi
echo "Streamglass was removed."
