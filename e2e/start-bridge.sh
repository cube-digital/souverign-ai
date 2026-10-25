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
# free the port if a stale e2e fake from a previous run still holds it
for pid in $(lsof -ti tcp:8656 -sTCP:LISTEN 2>/dev/null || true); do
  if ps -o command= -p "$pid" | grep -q "memory-fake-main"; then kill "$pid" 2>/dev/null || true; fi
done
# children stay in this script's process group, so the runner's group kill reaches them
pnpm --filter @sa/bridge exec tsx test/fakes/memory-fake-main.ts &
MEM_PID=$!
BRIDGE_PID=
# kill a process tree leaf-first, so no child is reparented while its parent still holds the port
killtree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null || true); do killtree "$c"; done
  kill "$1" 2>/dev/null || true
}
cleanup() {
  trap - EXIT
  [[ -n $BRIDGE_PID ]] && killtree "$BRIDGE_PID"
  killtree "$MEM_PID"
  for pid in $(lsof -ti tcp:8656 -sTCP:LISTEN 2>/dev/null || true); do
    ps -o command= -p "$pid" | grep -q "memory-fake-main" && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 143' TERM INT
pnpm --filter @sa/bridge run start &
BRIDGE_PID=$!
wait "$BRIDGE_PID"
