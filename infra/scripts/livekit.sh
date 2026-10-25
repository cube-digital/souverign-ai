#!/usr/bin/env bash
# Local LiveKit call server (calls only). Installing it is a human step: brew install livekit.
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/scripts/secrets.sh
PID=.run/livekit.pid
LOG=.run/livekit.log
running() { [[ -f $PID ]] && kill -0 "$(cat "$PID")" 2>/dev/null; }
case ${1:-start} in
  start)
    if ! command -v livekit-server >/dev/null 2>&1; then
      echo "calls: livekit-server not installed (human step: brew install livekit); chat and voice still work"
      exit 0
    fi
    if running; then echo "calls: livekit already running (pid $(cat "$PID"))"; exit 0; fi
    args=(--config infra/livekit.yaml --bind "${SA_LIVEKIT_BIND:-127.0.0.1}")
    if [[ -n ${SA_LIVEKIT_NODE_IP:-} ]]; then args+=(--node-ip "$SA_LIVEKIT_NODE_IP"); fi
    LIVEKIT_KEYS="$LIVEKIT_API_KEY: $LIVEKIT_API_SECRET" nohup livekit-server "${args[@]}" >"$LOG" 2>&1 &
    echo $! >"$PID"
    for _ in $(seq 1 40); do
      if curl -fsS http://127.0.0.1:7880/ >/dev/null 2>&1; then
        echo "calls: livekit on ws://127.0.0.1:7880"
        exit 0
      fi
      sleep 0.25
    done
    echo "calls: livekit did not answer on :7880, see $LOG" >&2
    kill "$(cat "$PID")" 2>/dev/null || true
    rm -f "$PID"
    exit 1
    ;;
  stop)
    if running; then kill "$(cat "$PID")" 2>/dev/null || true; fi
    rm -f "$PID"
    ;;
  status)
    if running; then echo running; else echo stopped; fi
    ;;
  *)
    echo "usage: livekit.sh start|stop|status" >&2
    exit 2
    ;;
esac
