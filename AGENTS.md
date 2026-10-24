# Agent Guide — sovereign-agents

On-prem demo app: E2E chat + video calls with per-user AI agents; every model runs locally on one
Mac. Spec: `docs/superpowers/specs/2026-10-24-sovereign-agents-demo-design.md`. Its "Amendamente"
section and `decisions.md` win over the rest of the spec.

## Rules

- Inference stays local. No calls to external AI services; runtime runs with `HF_HUB_OFFLINE=1`.
  Network is for `make models`, `pnpm install` and `uv sync` only.
- Never run system installers (`brew`, `uv tool install`, `curl | bash`). If a tool is missing, stop
  and report the `make prereqs` output.
- One LLM resident at a time. Start and stop the stack only with `make up` / `make down`.
- Model ids live only in `config/models.yaml` (read via `uv run --quiet sa-models …` or
  `sa_infra.models_config`).
- The relay and the LiveKit SFU never see keys or plaintext; relay tests assert plaintext ∉ storage.
- Agent Hermes profiles disable every built-in toolset (`infra/hermes/toolsets.yaml`); agents get
  bridge MCP tools only.
- No secrets in git: `.env` is gitignored; generated keys go to `.run/` (mode 0600).
- Ports: LLM 8000, whisper 8081, Postgres 5433, Hermes smoke 8700, agents 8701–8709, audio-api 8645,
  memory 8646, bridge 8647, relay 8648, web 5173, LiveKit 7880/7881.

## Code style

- TypeScript: packages `@sa/*`, extend `tsconfig.base.json`, Biome for lint/format, vitest.
- Python 3.12 in the uv workspace (root `pyproject.toml`); ruff, line length 100;
  `from __future__ import annotations`.
- Shell: `set -euo pipefail`; `cd "$(dirname "$0")/../.."` to run from the repo root.

## Verification

- Unit: `make check`, or the narrowest pytest/vitest file. Must pass without models.
- Live: `make up && make smoke`, one session at a time. Live tests are marked `live` and import heavy
  libraries inside the test.
