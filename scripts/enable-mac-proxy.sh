#!/bin/bash
# Run as root through IT's management tool. This configures only HTTP/HTTPS on one network service.
set -eo pipefail
export LC_ALL=C

usage() {
  printf 'Usage: %s enable|disable "network service" proxy-port\n' "${0##*/}"
}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

if [[ ${1:-} == --help ]]; then usage; exit 0; fi
if [[ $# != 3 ]]; then usage >&2; exit 2; fi
action=$1
service=$2
port=$3
host=127.0.0.1
networksetup=/usr/sbin/networksetup

[[ "$(/usr/bin/uname -s)" == Darwin ]] || fail 'This helper requires macOS.'
(( EUID == 0 )) || fail 'Run as root through your IT management tool.'
[[ $action == enable || $action == disable ]] || fail 'Choose enable or disable.'
[[ -n $service && $service != -* ]] || fail 'Supply the macOS network service name.'
[[ $port =~ ^[0-9]{1,5}$ ]] || fail 'Supply a numeric proxy port.'
port=$((10#$port))
(( port >= 1024 && port <= 65535 )) || fail 'Proxy port must be between 1024 and 65535.'

read_proxy() {
  local settings
  settings=$("$networksetup" "-get${1}proxy" "$service") || return 1
  enabled=$(printf '%s\n' "$settings" | /usr/bin/sed -n 's/^Enabled: //p')
  server=$(printf '%s\n' "$settings" | /usr/bin/sed -n 's/^Server: //p')
  saved_port=$(printf '%s\n' "$settings" | /usr/bin/sed -n 's/^Port: //p')
  authenticated=$(printf '%s\n' "$settings" | /usr/bin/sed -n 's/^Authenticated Proxy Enabled: //p')
  [[ $enabled == Yes || $enabled == No ]] && [[ $saved_port =~ ^[0-9]+$ ]] &&
    [[ $authenticated == 0 || $authenticated == 1 ]]
}

matches_proxy() {
  [[ $server == "$host" && $saved_port == "$port" && $authenticated == 0 ]]
}

disable_matching() {
  read_proxy "$1" || return 1
  if matches_proxy && [[ $enabled == Yes ]]; then
    "$networksetup" "-set${1}proxystate" "$service" off || return 1
    read_proxy "$1" && [[ $enabled == No ]] || return 1
  fi
}

if [[ $action == disable ]]; then
  failed=0
  for kind in web secureweb; do disable_matching "$kind" || failed=1; done
  (( failed == 0 )) || fail "Could not disable every matching proxy on $service. Check Network settings."
  printf 'Disabled any active HTTP/HTTPS proxy matching %s:%s on %s.\n' "$host" "$port" "$service"
  exit 0
fi

# Check both protocols before touching either. Disabled but populated settings may belong to IT.
to_enable=()
for kind in web secureweb; do
  read_proxy "$kind" || fail "Could not read proxy settings for $service."
  if matches_proxy; then
    if [[ $enabled == Yes ]]; then continue; fi
  elif [[ $enabled != No || -n $server || $saved_port != 0 || $authenticated != 0 ]]; then
    fail "Existing $kind proxy settings on $service were left in place."
  fi
  to_enable+=("$kind")
done

/usr/sbin/lsof -t -a -c streamglass-engine -iTCP:"$port" -sTCP:LISTEN >/dev/null ||
  fail "Start Streamglass and verify its proxy is listening on port $port."

attempted=()
rollback() {
  local kind
  for kind in "${attempted[@]}"; do
    disable_matching "$kind" || printf 'Could not disable %s on %s. Check Network settings.\n' "$kind" "$service" >&2
  done
}
# A mixed success must leave neither newly enabled protocol active.
trap rollback EXIT
trap 'exit 1' HUP INT TERM
for kind in "${to_enable[@]}"; do
  attempted+=("$kind")
  "$networksetup" "-set${kind}proxy" "$service" "$host" "$port" ||
    fail "Could not set the $kind proxy on $service."
  "$networksetup" "-set${kind}proxystate" "$service" on ||
    fail "Could not enable the $kind proxy on $service."
  read_proxy "$kind" && matches_proxy && [[ $enabled == Yes ]] ||
    fail "Could not verify the $kind proxy on $service."
done
trap - EXIT HUP INT TERM
printf 'Enabled HTTP/HTTPS proxy at %s:%s on %s.\n' "$host" "$port" "$service"
