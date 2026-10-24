#!/usr/bin/env bash
# make prereqs: verify host tools. Prints the install command for anything missing;
# installs nothing itself (installers are run by a human, once).
set -uo pipefail
cd "$(dirname "$0")/../.."

missing=0
need() { # need <cmd> <install hint>
  if command -v "$1" >/dev/null 2>&1; then
    printf '  ok       %s\n' "$1"
  else
    printf '  MISSING  %-15s -> %s\n' "$1" "$2"
    missing=1
  fi
}
want() { # want <cmd> <hint>: needed by a later sub-project, not by SP0
  command -v "$1" >/dev/null 2>&1 && printf '  ok       %s\n' "$1" \
    || printf '  later    %-15s -> %s\n' "$1" "$2"
}

echo "host: $(sysctl -n machdep.cpu.brand_string), $(($(sysctl -n hw.memsize) / 1073741824)) GB"
need node "brew install node@22"
need pnpm "corepack enable && corepack prepare pnpm@9 --activate"
need uv "brew install uv"
need docker "install Docker Desktop"
need ffmpeg "brew install ffmpeg"
need espeak-ng "brew install espeak-ng   # Kokoro phonemes for fr/es/it"
need whisper-server "brew install whisper-cpp"
need vllm-mlx "uv tool install 'vllm-mlx==0.4.1'"
need hermes "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash   # then infra/hermes/pin.sh --pin"
want livekit-server "brew install livekit   # SP6"

if command -v node >/dev/null 2>&1 && ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)'; then
  echo "  node is older than 22"; missing=1
fi
if command -v docker >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  echo "  Docker is installed but not running"; missing=1
fi
exit "$missing"
