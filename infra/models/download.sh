#!/usr/bin/env bash
# make models: download every model in config/models.yaml. Resumable and idempotent.
# Usage: download.sh [--profile fast|quality|all] [--dry-run]
# Network is used here only; runtime runs with HF_HUB_OFFLINE=1.
set -euo pipefail
cd "$(dirname "$0")/../.."

profile=all
dry=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --profile) profile=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) echo "usage: $0 [--profile fast|quality|all] [--dry-run]" >&2; exit 2 ;;
  esac
done

m() { uv run --quiet sa-models "$@"; }
run() { echo "+ $*"; if ((dry == 0)); then "$@"; fi; }
hf() { run uvx --from 'huggingface_hub[cli]' hf download "$@"; }

dir=$(m models-dir)
run mkdir -p "$dir/whisper" "$dir/piper" "$dir/fixtures"

# 1. LLMs -> Hugging Face cache (vllm-mlx loads them by repo id)
if [[ $profile == all ]]; then profiles=(fast quality); else profiles=("$profile"); fi
for p in "${profiles[@]}"; do hf "$(m get "llm.profiles.$p.repo")"; done

# 2. Embeddings + Kokoro -> Hugging Face cache
hf "$(m get embeddings.repo)"
hf "$(m get tts.kokoro.repo)"

# 3. Whisper ggml -> models dir
hf "$(m get stt.model_repo)" "$(m get stt.model_file)" --local-dir "$dir/whisper"

# 4. Piper voices (.onnx + .onnx.json) -> models dir, keeping the repo's sub-paths
for lang in de ro; do
  v=$(m get "tts.piper.voices.$lang")
  hf "$(m get tts.piper.repo)" "$v.onnx" "$v.onnx.json" --local-dir "$dir/piper"
done

# 5. Postgres image, so make up works offline
run docker compose -f infra/docker-compose.yaml pull postgres

# 6. Warm lazy TTS assets and render the STT fixtures (needs network on the first run)
run uv run --group live python -m sa_infra.make_fixtures

echo "download: done -> $dir (+ Hugging Face cache)"
