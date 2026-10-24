#!/usr/bin/env bash
# e2e bridge: fresh embedded Postgres (pglite), migrate, seed with known test PINs, start.
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="$PWD/.run/e2e"
rm -rf "$RUN/pg"
mkdir -p "$RUN"
export DATABASE_URL="pglite://$RUN/pg"
export PORT=8657
export RELAY_INTERNAL_URL=http://127.0.0.1:8658
export RELAY_ADMIN_TOKEN=e2e-token
export AGENT_RUNTIME=echo
export BRIDGE_MASTER_KEY=e2e-master
export RT_SIM_URL=http://127.0.0.1:8659
export SA_DEMO_PINS=ana:111111,vlad:222222,rares:333333,janosch:444444
pnpm --filter @sa/bridge run migrate
# seed writes .run/demo-pins.txt; keep the developer's real demo PINs untouched
PINS=.run/demo-pins.txt
[[ -f $PINS ]] && cp "$PINS" "$RUN/demo-pins.bak"
pnpm --filter @sa/bridge run seed >/dev/null
if [[ -f $RUN/demo-pins.bak ]]; then mv "$RUN/demo-pins.bak" "$PINS"; else rm -f "$PINS"; fi
exec pnpm --filter @sa/bridge run start
