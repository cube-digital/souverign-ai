#!/usr/bin/env bash
# make down: stop what make up started (reverse order, children first), then postgres.
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/scripts/pidlib.sh

for name in hermes-smoke whisper llm; do
  f=.run/$name.pid
  [[ -f $f ]] || continue
  pid=$(cat "$f")
  if alive "$name"; then
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid"; fi
    echo "down: stopped $name"
  fi
  rm -f "$f"
done
docker compose -f infra/docker-compose.yaml stop postgres
