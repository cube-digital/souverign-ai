#!/usr/bin/env bash
# make dev: postgres + relay + bridge + simulated ops backend + web for manual testing. Foreground; Ctrl-C stops all.
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/scripts/secrets.sh
docker compose -f infra/docker-compose.yaml up -d --wait postgres
pnpm --filter @sa/bridge run migrate
echo "dev: open http://127.0.0.1:5173 (run make seed once for the demo users)"
exec pnpm --parallel --filter @sa/relay --filter @sa/bridge --filter @sa/ops-sim --filter @sa/web run dev
