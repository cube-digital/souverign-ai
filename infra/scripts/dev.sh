#!/usr/bin/env bash
# make dev: postgres + relay + bridge + web for manual testing. Foreground; Ctrl-C stops all.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .run
if [[ -f .env ]]; then set -a; source .env; set +a; fi
if [[ -z "${RELAY_ADMIN_TOKEN:-}" ]]; then
  if [[ ! -f .run/relay-admin.token ]]; then (umask 077; openssl rand -hex 32 >.run/relay-admin.token); fi
  RELAY_ADMIN_TOKEN=$(cat .run/relay-admin.token)
fi
export RELAY_ADMIN_TOKEN
docker compose -f infra/docker-compose.yaml up -d --wait postgres
pnpm --filter @sa/bridge run migrate
echo "dev: open http://127.0.0.1:5173 (run make seed once for the demo users)"
exec pnpm --parallel --filter @sa/relay --filter @sa/bridge --filter @sa/web run dev
