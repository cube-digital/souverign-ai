#!/usr/bin/env bash
# make up: start the local stack in the background. Logs and pidfiles in .run/.
# Usage: up.sh [fast|quality]. Safe to run twice: live services are left alone.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .run
if [[ -f .env ]]; then set -a; source .env; set +a; fi
if [[ -n "${1:-}" ]]; then export LLM_PROFILE="$1"; fi
HERMES_SMOKE_PORT=8700

source infra/scripts/pidlib.sh

start() { # start <name> <cmd...>
  local name=$1
  shift
  if alive "$name"; then
    echo "up: $name already running (pid $(cat ".run/$name.pid"))"
    return
  fi
  nohup "$@" >".run/$name.log" 2>&1 &
  echo $! >".run/$name.pid"
  echo "up: started $name (pid $!)"
}

wait_http() { # wait_http <name> <url> <timeout_s>
  local name=$1 url=$2 timeout=$3 t=0
  until curl -fs -o /dev/null "$url"; do
    if ! alive "$name"; then
      echo "up: $name exited; last lines of .run/$name.log:" >&2
      tail -n 30 ".run/$name.log" >&2
      exit 1
    fi
    if ((t++ >= timeout)); then
      echo "up: $name not healthy after ${timeout}s ($url)" >&2
      exit 1
    fi
    sleep 1
  done
  echo "up: $name healthy"
}

docker compose -f infra/docker-compose.yaml up -d --wait postgres
echo "up: postgres healthy on 127.0.0.1:${SA_PG_PORT:-5433}"

start llm infra/models/start-llm.sh
start whisper infra/models/start-whisper.sh
wait_http llm "http://127.0.0.1:$(uv run --quiet sa-models get llm.port)/v1/models" 300
wait_http whisper "http://127.0.0.1:$(uv run --quiet sa-models get stt.port)/" 60

if command -v hermes >/dev/null 2>&1; then
  uv run --quiet python -m sa_infra.hermes_profile smoke
  # A running host gateway (the human's default profile) must rescan profiles/ (<=30 s) before
  # it lets sa-smoke run standalone; until then `gateway run` exits at once. Retry.
  for attempt in 1 2 3 4 5; do
    start hermes-smoke hermes -p sa-smoke gateway run
    sleep 3
    alive hermes-smoke && break
    if ((attempt == 5)); then break; fi
    echo "up: hermes-smoke exited (attempt $attempt), retrying in 10s" >&2
    sleep 10
  done
  wait_http hermes-smoke "http://127.0.0.1:$HERMES_SMOKE_PORT/health" 60
else
  echo "up: hermes not installed, smoke gateway skipped (see make prereqs)" >&2
fi
