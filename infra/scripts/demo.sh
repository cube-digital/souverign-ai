#!/usr/bin/env bash
# make demo: models, relay, bridge, simulated ops backend and the built web app on http://127.0.0.1:5173.
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/scripts/secrets.sh
infra/scripts/up.sh "${1:-}"
docker compose -f infra/docker-compose.yaml up -d --wait postgres
pnpm --filter @sa/bridge run migrate
pnpm --filter @sa/web run build
echo "demo: http://127.0.0.1:5173 (make share publishes it on your tailnet)"
exec caffeinate -dimsu pnpm --parallel --filter @sa/relay --filter @sa/bridge --filter @sa/rt-sim --filter @sa/web run serve
