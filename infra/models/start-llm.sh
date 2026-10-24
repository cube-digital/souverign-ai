#!/usr/bin/env bash
# Start the single resident LLM (spec A3/A6). Usage: start-llm.sh [fast|quality]
# Runs in the foreground; infra/scripts/up.sh backgrounds it. Never start two.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ -n "${1:-}" ]]; then export LLM_PROFILE="$1"; fi

m() { uv run --quiet sa-models "$@"; }
profile=$(m profile)
repo=$(m llm repo)
tool_parser=$(m llm tool_call_parser)
reasoning_parser=$(m llm reasoning_parser)
host=$(m get llm.host)
port=$(m get llm.port)

if [[ $profile == quality ]]; then
  need=$(m llm requires_wired_limit_mb)
  have=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)
  if ((have < need)); then
    echo "start-llm: profile quality needs 'sudo sysctl iogpu.wired_limit_mb=$need' (now $have) and other apps closed" >&2
    exit 1
  fi
fi

args=(serve "$repo" --host "$host" --port "$port" --continuous-batching
  --enable-auto-tool-choice --tool-call-parser "$tool_parser")
if [[ -n $reasoning_parser ]]; then args+=(--reasoning-parser "$reasoning_parser"); fi

echo "start-llm: profile=$profile repo=$repo port=$port" >&2
export HF_HUB_OFFLINE=1 # weights must already be in the HF cache (make models)
exec vllm-mlx "${args[@]}"
