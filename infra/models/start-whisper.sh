#!/usr/bin/env bash
# Start whisper.cpp's server (Homebrew whisper-cpp, Metal). Foreground.
# --convert lets it accept any audio ffmpeg can read (webm/opus from the browser later).
set -euo pipefail
cd "$(dirname "$0")/../.."

m() { uv run --quiet sa-models "$@"; }
model="$(m models-dir)/whisper/$(m get stt.model_file)"
if [[ ! -f $model ]]; then
  echo "start-whisper: missing $model (run make models)" >&2
  exit 1
fi
exec whisper-server --model "$model" --host "$(m get stt.host)" --port "$(m get stt.port)" \
  --language auto --threads 4 --convert
