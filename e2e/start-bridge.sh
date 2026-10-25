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
export SA_FORCE_FIRST_TOOL=0
export BRIDGE_MASTER_KEY=e2e-master
export OPS_SIM_URL=http://127.0.0.1:8659
export SA_DEMO_PINS=ana:111111,vlad:222222,rares:333333,janosch:444444
pnpm --filter @sa/bridge run migrate
# seed writes .run/demo-pins.txt; keep the developer's real demo PINs untouched
PINS=.run/demo-pins.txt
[[ -f $PINS ]] && cp "$PINS" "$RUN/demo-pins.bak"
pnpm --filter @sa/bridge run seed >/dev/null
if [[ -f $RUN/demo-pins.bak ]]; then mv "$RUN/demo-pins.bak" "$PINS"; else rm -f "$PINS"; fi

# fake memory service (127.0.0.1 only) and an emptied outbox
export MEMORY_PORT=8656
export MEMORY_URL=http://127.0.0.1:8656
export MEMORY_TOKEN=e2e-memory-token
export SA_OUTBOX_DIR="$PWD/.run/e2e-outbox"
rm -rf "$SA_OUTBOX_DIR"
mkdir -p "$SA_OUTBOX_DIR"
pnpm --filter @sa/bridge exec tsx test/fakes/memory-fake-main.ts &
MEM_PID=$!
BRIDGE_PID=
cleanup() {
  [[ -n $BRIDGE_PID ]] && kill "$BRIDGE_PID" 2>/dev/null || true
  kill "$MEM_PID" 2>/dev/null || true
  pkill -P "$MEM_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM INT
pnpm --filter @sa/bridge run start &
BRIDGE_PID=$!
wait "$BRIDGE_PID"
