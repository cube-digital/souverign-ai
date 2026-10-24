# Local models and stack

All inference is local. Network is used only by `make models`, `uv sync` and `pnpm install`.

## Run the stack

```
make prereqs   # host tools; prints install commands for anything missing (never installs)
make models    # download every model in config/models.yaml, render the STT fixtures (~30 GB, resumable)
make up        # postgres :5433, vllm-mlx :8000, whisper-server :8081, Hermes smoke gateway :8700
make smoke     # live suite, offline, with egress + memory guards
make down
```

`make up` is idempotent. Logs and pidfiles are in `.run/`.

## Profiles

| Profile | Model | Use |
|---|---|---|
| `fast` (default) | `mlx-community/Qwen3.5-9B-8bit` | building and testing |
| `quality` | `mlx-community/gemma-4-26b-a4b-it-4bit` | the demo |

Switch with `make up PROFILE=quality` (stop the stack first: one LLM at a time). `quality` needs
`sudo sysctl iogpu.wired_limit_mb=30000` and other apps closed. Model ids live only in
`config/models.yaml`.

## Fallbacks

- Tool calls come back as plain text: set `tool_call_parser: auto` for that profile in
  `config/models.yaml`.
- vllm-mlx cannot serve a model: run LM Studio (MLX) and point it at the same `:8000/v1`.
- Meetings (SP6), if three tracks do not keep up with whisper: `mlx-community/parakeet-tdt-0.6b-v3`.

## Findings from the first real bring-up

- Dependency resolution of the `live` extra had no conflict (`uv lock`). Two additions were
  needed: `pillow` and `torchvision`, because the EmbeddingGemma 2 processors import them even for
  text-only use.
- The `espeakng-loader` wheel (pulled by misaki) ships without phoneme data and aborts the process
  on first use. `sa_infra.make_fixtures.use_system_espeak()` points it at the Homebrew espeak-ng.
- misaki (Kokoro English) loads spaCy `en_core_web_sm` and pip-downloads it when missing. It is
  pinned as a direct-URL wheel in the `live` extra (`infra/py/pyproject.toml`, in `uv.lock`), so
  `uv sync` installs it and nothing downloads at smoke time.
- `mcp` 2.x renamed `FastMCP` to `MCPServer`; `mcp_echo.py` accepts both.
- A running Hermes host gateway (the default profile) multiplexes every profile and refuses a
  second one. The smoke profile sets `gateway.standalone: true`; the host picks that up within
  ~30 s, so `up.sh` retries `hermes -p sa-smoke gateway run` for up to a minute.
- whisper-server's `verbose_json` reports `"language": "english"` (a name), not the ISO code.
- `GET /v1/toolsets` on the Hermes API server lists each built-in toolset with `enabled`; the
  smoke test requires none enabled and every listed toolset present in `infra/hermes/toolsets.yaml`
  (this version adds video, video_gen, x_search, stt, kanban, context_engine, connections, yuanbao,
  computer_use, a2a, discord, discord_admin to the original list).

## Provenance

| Model | Repo | Revision | License (model card) | On disk |
|---|---|---|---|---|
| LLM fast | `mlx-community/Qwen3.5-9B-8bit` | `16daa48` | Apache-2.0 | 9.7 GB |
| LLM quality | `mlx-community/gemma-4-26b-a4b-it-4bit` | `0d77464` | Apache-2.0 | 14 GB |
| Embeddings | `google/embeddinggemma-2` | `914f7f8` | Apache-2.0 | 1.4 GB |
| TTS | `mlx-community/Kokoro-82M-bf16` | `a71e4d3` | Apache-2.0 | 372 MB |
| STT | `ggerganov/whisper.cpp` `ggml-large-v3-turbo-q5_0.bin` | `5359861` | MIT (whisper.cpp) | 547 MB |
| TTS de/ro | `rhasspy/piper-voices` (thorsten medium, mihai medium) | `main` at download | per-voice MODEL_CARD (not checked) | 122 MB |

## Measured (Apple M4 Max, 36 GB, profile `fast`)

- System memory used at the guard, with LLM, whisper, Hermes, Kokoro and EmbeddingGemma resident:
  30.5 GiB (limit 32 GiB, so little headroom).
- LLM time to first token for the `OK` prompt: 0.15 s (whole reply 0.13 s non-streaming).
- STT wall time for `en_10s.wav` (11.9 s of audio): 1.07 s.
