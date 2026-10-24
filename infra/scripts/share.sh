#!/usr/bin/env bash
# make share / make unshare: publish http://127.0.0.1:5173 on your tailnet over HTTPS, or stop.
set -euo pipefail
ts=${TAILSCALE:-tailscale}
if ! command -v "$ts" >/dev/null 2>&1; then ts=/Applications/Tailscale.app/Contents/MacOS/Tailscale; fi
if [[ ! -x $ts ]] && ! command -v "$ts" >/dev/null 2>&1; then
  echo "share: install Tailscale (https://tailscale.com/download/mac), sign in, enable HTTPS" >&2
  exit 1
fi
case "${1:-on}" in
  on) "$ts" serve --bg --https=443 http://127.0.0.1:5173 && "$ts" serve status ;;
  off) "$ts" serve --https=443 off ;;
  *) echo "usage: $0 on|off" >&2; exit 2 ;;
esac
