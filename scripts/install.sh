#!/bin/bash
# Install or update Streamglass: download the latest release, verify its checksum, replace any copy in the
# chosen folder (quitting it first) and open it.
# Release builds are unsigned, so this removes the quarantine flag macOS adds to downloads; without that,
# Gatekeeper refuses to open the app.
#   STREAMGLASS_DIR=~/Tools      install there without asking (the prompt defaults to /Applications)
#   STREAMGLASS_VERSION=1.0.4    install a specific version
#   STREAMGLASS_FORCE=1          reinstall even when that version is already installed
set -euo pipefail

REPO="salomohutapea/streamglass"
here="$PWD"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "Streamglass releases are built for Apple silicon Macs only." >&2
  exit 1
fi

if [ -n "${STREAMGLASS_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/v${STREAMGLASS_VERSION#v}"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

# Ask where to install. Reads the terminal directly because stdin is the script under `curl | bash`.
dir="${STREAMGLASS_DIR:-}"
if [ -z "${dir}" ] && { : </dev/tty; } 2>/dev/null; then
  # Default to an existing install so rerunning the script updates it in place.
  default=1
  if [ -d "/Applications/Streamglass.app" ]; then default=1
  elif [ -d "$HOME/Applications/Streamglass.app" ]; then default=2
  elif [ -d "${here}/Streamglass.app" ]; then default=3
  fi
  mark() {
    [ "${default}" = "$1" ] || return 0
    if [ -d "$2/Streamglass.app" ]; then echo " (installed here, default)"; else echo " (default)"; fi
  }
  echo "Where should Streamglass be installed?"
  echo "  1) /Applications$(mark 1 /Applications)"
  echo "  2) ~/Applications, no admin rights needed$(mark 2 "$HOME/Applications")"
  echo "  3) This folder: ${here}$(mark 3 "${here}")"
  echo "  4) Another folder"
  printf "Choose 1-4 [%s]: " "${default}"
  read -r choice </dev/tty || choice=""
  case "${choice:-$default}" in
    1) dir="/Applications" ;;
    2) dir="$HOME/Applications" ;;
    3) dir="${here}" ;;
    4) printf "Folder: "; read -r dir </dev/tty
       [ -n "${dir}" ] || { echo "No folder given." >&2; exit 1; } ;;
    *) echo "Unknown choice: ${choice}" >&2; exit 1 ;;
  esac
fi
dir="${dir:-/Applications}"
case "${dir}" in "~") dir="$HOME" ;; "~/"*) dir="$HOME/${dir#\~/}" ;; esac
case "${dir}" in /*) ;; *) dir="${here}/${dir}" ;; esac
dir="${dir%/}"
APP="${dir}/Streamglass.app"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

echo "Checking the latest release..."
curl -fsSL "$base/SHA256SUMS.txt" -o SHA256SUMS.txt
zip="$(awk '/-arm64-mac\.zip$/ {print $2; exit}' SHA256SUMS.txt)"
if [ -z "${zip}" ]; then
  echo "No macOS zip found in the release checksums." >&2
  exit 1
fi

latest="${zip#Streamglass-}"; latest="${latest%-arm64-mac.zip}"
installed="$(defaults read "${APP}/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)"
if [ "${installed}" = "${latest}" ] && [ -z "${STREAMGLASS_FORCE:-}" ]; then
  echo "Streamglass ${installed} is already installed. Set STREAMGLASS_FORCE=1 to reinstall."
  open "${APP}"
  exit 0
fi
[ -n "${installed}" ] && echo "Updating Streamglass ${installed} to ${latest}..."

echo "Downloading ${zip}..."
curl -fL --progress-bar "$base/${zip}" -o "${zip}"
grep " ${zip}\$" SHA256SUMS.txt | shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch for ${zip}; nothing was installed." >&2; exit 1; }
ditto -x -k "${zip}" extracted
[ -d extracted/Streamglass.app ] || { echo "The download did not contain Streamglass.app." >&2; exit 1; }

if pgrep -xq Streamglass; then
  echo "Quitting the running Streamglass..."
  osascript -e 'quit app "Streamglass"' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do pgrep -xq Streamglass || break; sleep 0.5; done
  if pgrep -xq Streamglass; then
    echo "Streamglass is still running. Quit it and run this script again." >&2
    exit 1
  fi
fi

mkdir -p "${dir}" 2>/dev/null || true
sudo=""
if [ ! -w "${dir}" ] || { [ -e "${APP}" ] && [ ! -w "${APP}" ]; }; then
  if [ "${dir}" != "/Applications" ]; then
    echo "Cannot write to ${dir}. Choose a folder you own, such as ~/Applications." >&2
    exit 1
  fi
  echo "/Applications needs an administrator password. If you are not allowed to install there, rerun and choose ~/Applications."
  sudo="sudo"
fi
$sudo rm -rf "${APP}"
$sudo ditto extracted/Streamglass.app "${APP}"
$sudo xattr -dr com.apple.quarantine "${APP}" 2>/dev/null || true

version="$(defaults read "${APP}/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo unknown)"
echo "Installed Streamglass ${version} to ${APP}"
[ "${dir}" = "/Applications" ] || echo "Run this script again with the same folder to update it."
open "${APP}"
