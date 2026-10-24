#!/usr/bin/env bash
# Record (or check) the installed Hermes Agent version in infra/hermes/VERSION.
# Install Hermes first (human, once): see make prereqs.
# Usage: pin.sh --pin | --check
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v hermes >/dev/null 2>&1 || { echo "pin: hermes not installed (see make prereqs)" >&2; exit 1; }
src="${HERMES_SRC:-$HOME/.hermes/hermes-agent}"
version=$(hermes --version 2>/dev/null | head -n 1)
sha=unknown
if [[ -d $src/.git ]]; then sha=$(git -C "$src" rev-parse HEAD); fi

case "${1:-}" in
  --pin)
    printf 'version: %s\nsha: %s\n' "$version" "$sha" >infra/hermes/VERSION
    cat infra/hermes/VERSION
    ;;
  --check)
    if ! grep -qx "sha: $sha" infra/hermes/VERSION; then
      echo "pin: installed hermes ($sha) differs from infra/hermes/VERSION:" >&2
      cat infra/hermes/VERSION >&2
      exit 1
    fi
    ;;
  *) echo "usage: $0 --pin | --check" >&2; exit 2 ;;
esac
