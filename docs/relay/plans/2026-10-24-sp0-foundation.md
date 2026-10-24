# SP0 — Foundation and Models Plan

**Goal:** a fresh clone passes `make install && make check` without any model; with the host prerequisites installed, `make models && make up && make smoke` proves every local model answers, offline, within 32 GiB.
**Spec:** docs/superpowers/specs/2026-10-24-sovereign-agents-demo-design.md (§3, §6, §11 SP0 and the "Amendamente" section, which wins) + docs/superpowers/specs/decisions.md
**Architecture:** a pnpm + uv monorepo. `config/models.yaml` is the single source for model ids; shell scripts read it through the `sa-models` CLI from the Python package `sa-infra` (`infra/py`). `make up` starts Postgres (Docker), one vllm-mlx LLM, whisper-server and a Hermes smoke gateway as background processes with pidfiles in `.run/`. `make smoke` runs pytest tests marked `live` against that stack, then checks there is no egress and memory stays under 32 GiB.

## Global Constraints

- Repo: this repository. Read `AGENTS.md` once T1 lands.
- Inference is local. Runtime processes run with `HF_HUB_OFFLINE=1` (`TRANSFORMERS_OFFLINE=1` for smoke). Network is used only by `pnpm install`, `uv sync`/`uv lock` and `make models`.
- Never run system installers: no `brew`, no `uv tool install`, no `curl … | bash`. If a check needs a missing tool, stop and report the `make prereqs` output as BLOCKED.
- Never start an LLM outside T6. Only T6 runs `make up` / `make smoke`; it runs alone in the last wave. Never start a second vllm-mlx.
- Versions: Python 3.12 (`.python-version`), `requires-python = ">=3.12,<3.14"`, Node ≥ 22, pnpm 9, vllm-mlx 0.4.1. uv resolution limited to `sys_platform == 'darwin' and platform_machine == 'arm64'`.
- Ports: LLM 8000, whisper-server 8081, Postgres 127.0.0.1:5433 (a Homebrew Postgres already listens on 5432), Hermes smoke 8700.
- Model ids appear only in `config/models.yaml`. Scripts call `uv run --quiet sa-models …`; Python calls `sa_infra.models_config`.
- Python: ruff rules `E,F,I,B,UP`, line length 100, `from __future__ import annotations` at the top of every module. Run `uv run ruff format` and `uv run ruff check --fix` before each commit.
- Shell: `#!/usr/bin/env bash`, `set -euo pipefail`, first line after it `cd "$(dirname "$0")/../.."` so every script runs from the repo root. Make scripts executable (`chmod +x`).
- Tests: `make check` must pass with no model and no running service. Live tests carry `@pytest.mark.live` (or `pytestmark`), import heavy libraries (torch, sentence_transformers, mlx_audio, piper) inside fixtures or test bodies, and fail rather than skip when a service is down.
- No secrets in git. `.env` is gitignored; generated keys go to `.run/` with mode 0600.
- Commit messages: `feat(sp0): …` / `chore(sp0): …`, one commit per task.

## Review Focus

- The egress guard really covers child processes and the pytest process itself, and treats `::1` and `::ffff:127.0.0.1` as loopback but `fe80::…` and LAN addresses as egress.
- The Hermes smoke profile leaves no built-in toolset enabled (terminal above all), binds its API server to 127.0.0.1, and the key file is 0600.
- `make up` twice never starts a second LLM; `make down` kills children and removes pidfiles.
- `download.sh --dry-run` makes no network call and writes nothing.
- No runtime path can download: `start-llm.sh` exports `HF_HUB_OFFLINE=1`; `make smoke` sets both offline variables; any lazy asset (spaCy, Kokoro voices, Piper voices) is fetched in `make models`, never at smoke time.
- Nothing pins a model id outside `config/models.yaml`.

## Human Steps (before wave 3 starts; can run right now)

The run itself never installs system tools. Before T6 runs, on this Mac:

```bash
brew install whisper-cpp espeak-ng
uv tool install 'vllm-mlx==0.4.1'
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Docker Desktop must be running. Optional head start on the ~25 GB of LLM weights (T6's `make models` resumes them):

```bash
uvx --from 'huggingface_hub[cli]' hf download mlx-community/Qwen3.5-9B-8bit
uvx --from 'huggingface_hub[cli]' hf download mlx-community/gemma-4-26b-a4b-it-4bit
```

## Tasks

### T1: Monorepo scaffold and model config

Create the pnpm + uv workspaces, the model config with its loader, the Makefile and the repo guides. Then run:

```bash
pnpm add -D -w @biomejs/biome typescript vitest @types/node
uv lock && uv sync
```

and commit the generated `pnpm-lock.yaml` and `uv.lock`. `README.md` already exists (GitHub's initial commit); replace its whole content with the version below. If the installed Biome rejects `biome.json`, run `pnpm biome migrate --write` and keep the result. pnpm 9 exits 0 for `pnpm -r --if-present run …` in an empty workspace (verified), so the `typecheck`/`test` targets stay in `make check`.

`package.json`:

```json
{
  "name": "sovereign-agents",
  "private": true,
  "packageManager": "pnpm@9.10.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "lint": "biome check .",
    "format": "biome format --write .",
    "typecheck": "pnpm -r --if-present run typecheck",
    "test": "pnpm -r --if-present run test"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "services/*"
  - "packages/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`biome.json`:

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } }
}
```

`.python-version`:

```
3.12
```

`pyproject.toml` (root, virtual uv workspace):

```toml
[project]
name = "sovereign-agents"
version = "0.0.0"
requires-python = ">=3.12,<3.14"
dependencies = []

[tool.uv]
package = false
environments = ["sys_platform == 'darwin' and platform_machine == 'arm64'"]

[tool.uv.workspace]
members = ["infra/py"]

[tool.uv.sources]
sa-infra = { workspace = true }

[dependency-groups]
dev = ["pytest>=8.3", "ruff>=0.6", "sa-infra"]
live = ["sa-infra[live]"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]

[tool.pytest.ini_options]
addopts = "-q -m 'not live'"
markers = ["live: needs the running local stack (make models + make up)"]
testpaths = ["infra/py/tests"]
```

`infra/py/pyproject.toml` (the `live` extra stays empty here; T6 fills it):

```toml
[project]
name = "sa-infra"
version = "0.0.0"
description = "Sovereign Agents dev tooling: model config, guards, Hermes smoke profile, smoke tests"
requires-python = ">=3.12,<3.14"
dependencies = [
  "pyyaml>=6.0",
  "psutil>=6.0",
  "httpx>=0.27",
  "mcp>=1.10",
]

[project.optional-dependencies]
live = []

[project.scripts]
sa-models = "sa_infra.models_config:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/sa_infra"]
```

`infra/py/src/sa_infra/__init__.py`:

```python
"""Sovereign Agents dev tooling."""
```

`infra/py/src/sa_infra/models_config.py`:

```python
"""Read config/models.yaml, the single source of truth for model ids.

Shell scripts call `uv run --quiet sa-models <command>`; Python code calls `load()`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[4]
CONFIG_PATH = Path(os.environ.get("SA_MODELS_CONFIG") or REPO_ROOT / "config" / "models.yaml")
USAGE = "usage: sa-models get <dotted.key> | profile | llm <key> | models-dir"


def load(path: Path | None = None) -> dict[str, Any]:
    with open(path or CONFIG_PATH, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def get(cfg: dict[str, Any], dotted: str) -> Any:
    node: Any = cfg
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            raise KeyError(dotted)
        node = node[part]
    return node


def active_profile(cfg: dict[str, Any]) -> str:
    name = os.environ.get("LLM_PROFILE") or cfg["llm"]["active_profile"]
    if name not in cfg["llm"]["profiles"]:
        raise KeyError(f"llm.profiles.{name}")
    return name


def models_dir(cfg: dict[str, Any]) -> Path:
    return Path(os.environ.get("SA_MODELS_DIR") or cfg["paths"]["models_dir"]).expanduser()


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    cfg = load()
    try:
        match args:
            case ["get", dotted]:
                value = get(cfg, dotted)
            case ["profile"]:
                value = active_profile(cfg)
            case ["llm", key]:
                value = get(cfg, f"llm.profiles.{active_profile(cfg)}.{key}")
            case ["models-dir"]:
                value = models_dir(cfg)
            case _:
                print(USAGE, file=sys.stderr)
                return 2
    except KeyError as exc:
        print(f"sa-models: missing key {exc}", file=sys.stderr)
        return 1
    if isinstance(value, dict | list):
        print(yaml.safe_dump(value, sort_keys=False).rstrip())
    else:
        print("" if value is None else value)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

`infra/py/tests/test_models_config.py`:

```python
from __future__ import annotations

from sa_infra import models_config as mc


def test_llm_lookup_follows_profile_override(monkeypatch, capsys):
    cfg = mc.load()
    monkeypatch.setenv("LLM_PROFILE", "quality")
    assert mc.main(["llm", "repo"]) == 0
    assert capsys.readouterr().out.strip() == cfg["llm"]["profiles"]["quality"]["repo"]
    monkeypatch.setenv("LLM_PROFILE", "nope")
    assert mc.main(["llm", "repo"]) == 1
```

`config/models.yaml`:

```yaml
# Single source of truth for every model the demo runs. All inference is local.
# Shell: `uv run --quiet sa-models llm repo` · Python: sa_infra.models_config.load()
# Adding a model here means updating the memory table in the spec (§6).

paths:
  models_dir: ~/.cache/sovereign-agents/models # non-HF artifacts: ggml, piper voices, fixtures. Override: SA_MODELS_DIR

llm:
  active_profile: fast # D-1: fast while building, quality for the demo. Override: LLM_PROFILE / make up PROFILE=
  host: 127.0.0.1
  port: 8000
  profiles:
    fast:
      repo: mlx-community/Qwen3.5-9B-8bit
      tool_call_parser: qwen # fallback if tool calls do not parse: auto
      reasoning_parser: qwen3
      approx_gb: 10.0
    quality:
      repo: mlx-community/gemma-4-26b-a4b-it-4bit
      tool_call_parser: auto # auto tries the Gemma 4 format first
      reasoning_parser: ""
      approx_gb: 14.5
      requires_wired_limit_mb: 30000

embeddings:
  repo: google/embeddinggemma-2 # Apache-2.0
  dim: 768
  mrl_dim: 512 # store 512 dims, re-normalized (spec A5)
  dtype: bfloat16 # never float16: NaN
  device: mps
  query_prompt: "task: search result | query: "
  document_prompt: "title: {title} | text: "
  fallback_repo: Qwen/Qwen3-Embedding-0.6B # SP3, if recall@3 < 0.8

stt:
  host: 127.0.0.1
  port: 8081
  model_repo: ggerganov/whisper.cpp
  model_file: ggml-large-v3-turbo-q5_0.bin
  meeting_fallback_repo: mlx-community/parakeet-tdt-0.6b-v3 # SP6, only if 3 tracks do not keep up

tts:
  kokoro:
    repo: mlx-community/Kokoro-82M-bf16
    sample_rate: 24000
    languages:
      en: { lang_code: a, voice: af_heart }
      fr: { lang_code: f, voice: ff_siwis }
      es: { lang_code: e, voice: ef_dora }
      it: { lang_code: i, voice: if_sara }
  piper:
    repo: rhasspy/piper-voices
    voices:
      de: de/de_DE/thorsten/medium/de_DE-thorsten-medium
      ro: ro/ro_RO/mihai/medium/ro_RO-mihai-medium
```

`Makefile` (recipes indented with a tab):

```make
SHELL := /bin/bash
.DEFAULT_GOAL := help
PROFILE ?=

help: ## list targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-9s %s\n", $$1, $$2}'

install: ## install JS + Python dev dependencies
	pnpm install
	uv sync

check: ## lint + unit tests (no models, no services)
	pnpm lint
	pnpm typecheck
	pnpm test
	uv run ruff check .
	uv run ruff format --check .
	uv run pytest

prereqs: ## check host tools; prints install commands for anything missing
	infra/scripts/prereqs.sh

models: ## download every model in config/models.yaml (resumable, ~30 GB)
	infra/models/download.sh $(if $(PROFILE),--profile $(PROFILE),)

up: ## start postgres, the LLM (PROFILE=fast|quality), whisper, the Hermes smoke gateway
	infra/scripts/up.sh $(PROFILE)

down: ## stop everything make up started
	infra/scripts/down.sh

smoke: ## live checks against the running stack, offline, with egress + memory guards
	NETWORK_GUARD=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 uv run --group live pytest -m live infra/py/tests/live

.PHONY: help install check prereqs models up down smoke
```

`.gitignore`:

```
node_modules/
dist/
.venv/
__pycache__/
*.pyc
.pytest_cache/
.ruff_cache/
.run/
.env
*.log
.DS_Store
```

`.env.example`:

```
# Copy to .env (gitignored). Values stay on this machine.
LLM_PROFILE=            # fast | quality; empty = llm.active_profile in config/models.yaml
SA_MODELS_DIR=          # empty = ~/.cache/sovereign-agents/models
SA_PG_PORT=5433         # 5433 because a Homebrew Postgres already uses 5432
POSTGRES_PASSWORD=sa_dev_only
HERMES_SMOKE_API_KEY=   # empty = generated into .run/hermes-smoke.key
```

`README.md`:

````markdown
# Sovereign Agents

On-prem demo: end-to-end encrypted chat and video calls where every user brings their
own AI agents. Every model (LLM, speech-to-text, text-to-speech, embeddings) runs locally on one Mac
(M4 Max, 36 GB). Nothing calls an external AI service.

- Design: [docs/superpowers/specs/2026-10-24-sovereign-agents-demo-design.md](docs/superpowers/specs/2026-10-24-sovereign-agents-demo-design.md)
- Decisions: [docs/superpowers/specs/decisions.md](docs/superpowers/specs/decisions.md)
- Plans: [docs/relay/plans/](docs/relay/plans/)

## Quick start

```bash
make prereqs   # checks host tools, prints install commands for anything missing
make install   # JS + Python dev dependencies
make check     # lint + unit tests, no models needed
make models    # downloads every model in config/models.yaml (~30 GB, resumable)
make up        # postgres, LLM (PROFILE=fast|quality), whisper, Hermes smoke gateway
make smoke     # live checks: tool calls, STT, TTS, embeddings, Hermes, no egress, <= 32 GiB
make down
```
````

`AGENTS.md`:

```markdown
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
```

`CLAUDE.md`:

```markdown
# Claude Guide

Follow `AGENTS.md`.
```

### T2: Egress, memory and WER guards

Four small modules in `infra/py/src/sa_infra/` plus their unit tests. They back the smoke run's on-prem and memory claims, so the tests target the boundaries.

`runfiles.py`
- `RUN_DIR = models_config.REPO_ROOT / ".run"`.
- `service_pids(run_dir: Path = RUN_DIR) -> dict[str, int]`: for every `*.pid` file, name = file stem, pid = int(content). Keep it only if `psutil.pid_exists(pid)`. A missing directory returns `{}`.

`egress.py`
- `@dataclass(frozen=True) class Conn: pid: int; status: str; remote_ip: str | None; remote_port: int | None`.
- `is_loopback(ip: str) -> bool`: strip an IPv6 zone suffix (`%lo0`), parse with `ipaddress`. True for 127.0.0.0/8, `::1`, and IPv4-mapped IPv6 whose mapped address is loopback (`::ffff:127.0.0.1`). Link-local (`fe80::…`), private LAN and public addresses are False.
- `offending(conns: Iterable[Conn]) -> list[Conn]`: every conn whose `remote_ip` is set and not loopback, whatever its status (UDP sockets report status `NONE` and still count).
- `collect(pids: Iterable[int], *, include_children: bool = True) -> list[Conn]`: for each pid, `psutil.Process(pid)` plus (if `include_children`) `.children(recursive=True)`; read `.net_connections(kind="inet")`. Skip processes that vanished (`psutil.NoSuchProcess`). Turn `psutil.AccessDenied` into `RuntimeError(f"cannot inspect pid {pid}")`: a guard that cannot look must fail, not pass. De-duplicate pids.
- `scan(pids, *, include_children=True) -> list[Conn]` = `offending(collect(...))`.

`memguard.py`
- `LIMIT_BYTES = 32 * 1024**3`.
- `used_bytes(vm=None) -> int`: `vm = vm or psutil.virtual_memory()`; return `vm.total - vm.available`. System-wide on purpose: RSS misses MLX's Metal allocations (spec amendment 7).
- `check(limit: int = LIMIT_BYTES, vm=None) -> tuple[bool, int]`: `(used <= limit, used)`.

`wer.py`
- `normalize(text: str) -> list[str]`: NFKC, `casefold()`, drop every character that is not a word character or whitespace (`re.sub(r"[^\w\s]", "", …)`), split on whitespace.
- `wer(reference: str, hypothesis: str) -> float`: word-level Levenshtein distance / number of reference words. Raise `ValueError` when the reference has no words.

Tests (four):
- `tests/test_egress.py::test_offending_flags_only_non_loopback_remotes`: one call on hand-built `Conn`s. Not flagged: remotes `127.0.0.1`, `127.4.5.6`, `::1`, `::ffff:127.0.0.1`, and a LISTEN socket with `remote_ip=None`. Flagged, exactly: `fe80::1%lo0`, `192.168.1.10`, `140.82.112.3`, and a UDP (`status="NONE"`) remote `8.8.8.8`.
- `tests/test_egress.py::test_collect_includes_child_processes`: open a listening socket on `127.0.0.1:0` in the test; spawn `python -c` (via `sys.executable`) that connects to it and sleeps; once accepted, `collect([os.getpid()])` contains a `Conn` with the child's pid and `remote_ip == "127.0.0.1"`, and `scan([os.getpid()]) == []`. Terminate the child in `finally`.
- `tests/test_memguard.py::test_limit_is_inclusive`: `SimpleNamespace(total=36 GiB, available=4 GiB)` → ok; `available=4 GiB - 1` → not ok; returned `used` matches.
- `tests/test_wer.py::test_wer_ignores_case_punctuation_and_counts_edits`: identical text with different case/punctuation → `0.0`; `"the cat sat down"` vs `"the cat sat town"` → `0.25`; `"a b c d"` vs `"a b d"` → `0.25`; empty reference raises `ValueError`.

### T3: Prerequisite check, model download, STT fixtures

`infra/scripts/prereqs.sh`:

```bash
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

if command -v node >/dev/null 2>&1 && ! node -e 'process.exit(+process.versions.node.split(".")[0] < 22)'; then
  echo "  node is older than 22"; missing=1
fi
if command -v docker >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  echo "  Docker is installed but not running"; missing=1
fi
exit "$missing"
```

`infra/models/download.sh`:

```bash
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
```

`infra/py/src/sa_infra/make_fixtures.py` (the `live` extra that provides numpy, soundfile, mlx-audio and piper lands in T6; nothing imports this module in `make check`):

```python
"""Warm lazy TTS assets and render the STT fixtures. Run once by `make models`.

Network is allowed here: Kokoro's English G2P may fetch its spaCy model on first use.
The smoke run afterwards is offline. WAVs go to <models_dir>/fixtures/ as 16 kHz mono;
the reference texts live in infra/py/tests/live/fixtures/.
"""

from __future__ import annotations

import io
import wave
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from sa_infra import models_config as mc

TEXTS = Path(__file__).resolve().parents[2] / "tests" / "live" / "fixtures"
WARMUP = {"fr": "Bonjour à tous.", "es": "Hola a todos.", "it": "Ciao a tutti."}


def to_16k(audio: np.ndarray, sr: int) -> np.ndarray:
    n = round(len(audio) * 16000 / sr)
    x = np.linspace(0, len(audio) - 1, n)
    return np.interp(x, np.arange(len(audio)), audio).astype(np.float32)


def kokoro(model: Any, text: str, lang: str, cfg: dict[str, Any]) -> np.ndarray:
    spec = cfg["tts"]["kokoro"]["languages"][lang]
    results = model.generate(text=text, voice=spec["voice"], lang_code=spec["lang_code"])
    return np.concatenate([np.asarray(r.audio, dtype=np.float32) for r in results])


def piper(text: str, lang: str, cfg: dict[str, Any]) -> tuple[np.ndarray, int]:
    from piper import PiperVoice

    onnx = mc.models_dir(cfg) / "piper" / f"{cfg['tts']['piper']['voices'][lang]}.onnx"
    voice = PiperVoice.load(str(onnx))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize_wav(text, wf)
    buf.seek(0)
    audio, sr = sf.read(buf, dtype="float32")
    return audio, sr


def main() -> int:
    from mlx_audio.tts.utils import load_model

    cfg = mc.load()
    out = mc.models_dir(cfg) / "fixtures"
    out.mkdir(parents=True, exist_ok=True)
    model = load_model(cfg["tts"]["kokoro"]["repo"])
    kokoro_sr = cfg["tts"]["kokoro"]["sample_rate"]

    en_text = (TEXTS / "en_10s.txt").read_text(encoding="utf-8").strip()
    sf.write(out / "en_10s.wav", to_16k(kokoro(model, en_text, "en", cfg), kokoro_sr), 16000)
    for lang, text in WARMUP.items():
        kokoro(model, text, lang, cfg)  # caches phonemizer assets; audio discarded

    de_audio, de_sr = piper((TEXTS / "de.txt").read_text(encoding="utf-8").strip(), "de", cfg)
    sf.write(out / "de.wav", to_16k(de_audio, de_sr), 16000)
    piper("Bună ziua.", "ro", cfg)
    print(f"fixtures: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

`infra/py/tests/live/fixtures/en_10s.txt` (no digits, so WER does not depend on number formatting):

```
The quarterly review is scheduled for Thursday morning. Please send the delivery timeline and the updated budget to the whole team before Wednesday evening, so everyone can prepare their questions.
```

`infra/py/tests/live/fixtures/de.txt`:

```
Das Treffen findet am Donnerstag statt. Bitte schicken Sie den Lieferplan vorher an das ganze Team.
```

### T4: Stack scripts: LLM, whisper, Postgres, up/down

`infra/docker-compose.yaml`:

```yaml
name: sovereign-agents
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: sa
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-sa_dev_only}
      POSTGRES_DB: sa
    ports:
      - "127.0.0.1:${SA_PG_PORT:-5433}:5432"
    volumes:
      - sa-pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sa -d sa"]
      interval: 2s
      timeout: 3s
      retries: 30
volumes:
  sa-pg:
```

`infra/models/start-llm.sh`:

```bash
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
```

`infra/models/start-whisper.sh`:

```bash
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
```

`infra/scripts/up.sh`:

```bash
#!/usr/bin/env bash
# make up: start the local stack in the background. Logs and pidfiles in .run/.
# Usage: up.sh [fast|quality]. Safe to run twice: live services are left alone.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .run
if [[ -f .env ]]; then set -a; source .env; set +a; fi
if [[ -n "${1:-}" ]]; then export LLM_PROFILE="$1"; fi
HERMES_SMOKE_PORT=8700

alive() { [[ -f .run/$1.pid ]] && kill -0 "$(cat ".run/$1.pid")" 2>/dev/null; }

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
  until curl -fsS -o /dev/null "$url"; do
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
  start hermes-smoke hermes -p sa-smoke gateway
  wait_http hermes-smoke "http://127.0.0.1:$HERMES_SMOKE_PORT/health" 60
else
  echo "up: hermes not installed, smoke gateway skipped (see make prereqs)" >&2
fi
```

`infra/scripts/down.sh`:

```bash
#!/usr/bin/env bash
# make down: stop what make up started (reverse order, children first), then postgres.
set -euo pipefail
cd "$(dirname "$0")/../.."

for name in hermes-smoke whisper llm; do
  f=.run/$name.pid
  [[ -f $f ]] || continue
  pid=$(cat "$f")
  if kill -0 "$pid" 2>/dev/null; then
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
```

### T5: Hermes smoke profile, toolset lockdown, MCP echo server

The Hermes API server runs every enabled toolset server-side, the terminal included. Agent profiles therefore disable all built-in toolsets and get MCP tools only (spec amendment 8). This task renders the smoke profile from the same template the bridge will use in SP2.

`infra/hermes/config.template.yaml`:

```yaml
# Hermes profile config for one Sovereign Agents agent. Rendered by
# sa_infra.hermes_profile (smoke) and by the bridge's HermesRuntime (SP2).
# Keys checked against the Hermes version pinned in infra/hermes/VERSION.
model:
  provider: custom
  base_url: "${LLM_BASE_URL}"
  default: "${LLM_MODEL}"
  api_key: local-no-key
agent:
  reasoning_effort: low
  disabled_toolsets: [] # filled from infra/hermes/toolsets.yaml
gateway:
  api_server:
    enabled: true
    host: 127.0.0.1
    port: ${API_PORT}
    key: "${API_KEY}"
mcp_servers: {} # filled per profile
```

`infra/hermes/toolsets.yaml`:

```yaml
# Built-in Hermes toolsets disabled for every Sovereign Agents profile (spec amendment 8).
# Agents get the bridge's MCP tools only. T6 checks this list against the pinned Hermes
# version: any built-in toolset that version lists and this file misses must be added.
disable:
  - terminal
  - file
  - code_execution
  - browser
  - web
  - vision
  - image_gen
  - tts
  - memory
  - session_search
  - skills
  - delegation
  - cronjob
  - messaging
  - homeassistant
  - todo
  - clarify
```

`infra/hermes/SOUL.template.md`:

```markdown
# ${AGENT_NAME}

You are ${AGENT_NAME}, an assistant that belongs to ${OWNER_NAME}. You run fully on-premises.

## How you work

- You only see what you were given: chats you were invited to, meetings whose participants
  consented, documents your owner taught you.
- Any action with an external effect (sending a message, publishing notes) is a proposal that your
  owner approves first. Say it is waiting for approval; never claim it is done.
- When you use memory or documents, cite them as [source · timestamp].
- Answer in the user's language. Never reveal hidden reasoning.

## Personality and rules (set by your owner)

${SOUL}
```

`infra/hermes/VERSION`:

```
version: unpinned
sha: unpinned
```

`infra/hermes/pin.sh`:

```bash
#!/usr/bin/env bash
# Record (or check) the installed Hermes Agent version in infra/hermes/VERSION.
# Install Hermes first (human, once): see make prereqs.
# Usage: pin.sh --pin | --check
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v hermes >/dev/null 2>&1 || { echo "pin: hermes not installed (see make prereqs)" >&2; exit 1; }
src="${HERMES_SRC:-$HOME/.hermes/hermes-agent}"
version=$(hermes --version 2>/dev/null | head -n 1)
sha=unknown
if [[ -d $src/.git ]]; then sha=$(git -C "$src" rev-parse HEAD); fi

case "${1:-}" in
  --pin)
    printf 'version: %s\nsha: %s\n' "$version" "$sha" >infra/hermes/VERSION
    cat infra/hermes/VERSION
    ;;
  --check)
    if ! grep -qx "sha: $sha" infra/hermes/VERSION; then
      echo "pin: installed hermes ($sha) differs from infra/hermes/VERSION:" >&2
      cat infra/hermes/VERSION >&2
      exit 1
    fi
    ;;
  *) echo "usage: $0 --pin | --check" >&2; exit 2 ;;
esac
```

`infra/py/src/sa_infra/mcp_echo.py`:

```python
"""Tiny stdio MCP server for the Hermes smoke test: one `add` tool that logs each call."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("sa-echo")
LOG = Path(os.environ.get("SA_ECHO_LOG", ".run/mcp-echo.log"))


@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two integers and return the sum."""
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": time.time(), "tool": "add", "a": a, "b": b}) + "\n")
    return a + b


if __name__ == "__main__":
    mcp.run()
```

`infra/py/src/sa_infra/hermes_profile.py`:

```python
"""Render Hermes profile homes from the templates in infra/hermes/.

`uv run python -m sa_infra.hermes_profile smoke` (called by `make up`) creates or refreshes
~/.hermes/profiles/sa-smoke: config on the local LLM, API server on 127.0.0.1:8700, every
built-in toolset disabled, one stdio MCP server (sa_echo). The bridge's HermesRuntime (SP2)
renders agent profiles from the same template.
"""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path
from string import Template
from typing import Any

import yaml

from sa_infra import models_config as mc

HERMES_DIR = mc.REPO_ROOT / "infra" / "hermes"
RUN_DIR = mc.REPO_ROOT / ".run"
SMOKE_PROFILE = "sa-smoke"
SMOKE_PORT = 8700


def builtin_toolsets() -> list[str]:
    data = yaml.safe_load((HERMES_DIR / "toolsets.yaml").read_text(encoding="utf-8"))
    return list(data["disable"])


def render_config(
    *,
    llm_base_url: str,
    llm_model: str,
    api_port: int,
    api_key: str,
    mcp_servers: dict[str, Any],
) -> dict[str, Any]:
    text = (HERMES_DIR / "config.template.yaml").read_text(encoding="utf-8")
    rendered = Template(text).substitute(
        LLM_BASE_URL=llm_base_url, LLM_MODEL=llm_model, API_PORT=api_port, API_KEY=api_key
    )
    config = yaml.safe_load(rendered)
    config["agent"]["disabled_toolsets"] = builtin_toolsets()
    config["mcp_servers"] = mcp_servers
    return config


def write_profile(home: Path, *, config: dict[str, Any], soul: str, env: dict[str, str]) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    (home / "SOUL.md").write_text(soul, encoding="utf-8")
    env_path = home / ".env"
    env_path.write_text("".join(f"{k}={v}\n" for k, v in env.items()), encoding="utf-8")
    env_path.chmod(0o600)


def smoke_key() -> str:
    RUN_DIR.mkdir(exist_ok=True)
    key_file = RUN_DIR / "hermes-smoke.key"
    key = os.environ.get("HERMES_SMOKE_API_KEY") or (
        key_file.read_text(encoding="utf-8").strip()
        if key_file.exists()
        else secrets.token_urlsafe(32)
    )
    key_file.write_text(key, encoding="utf-8")
    key_file.chmod(0o600)
    return key


def smoke() -> Path:
    cfg = mc.load()
    home = Path(os.environ.get("HERMES_PROFILES_DIR", "~/.hermes/profiles")).expanduser()
    home = home / SMOKE_PROFILE
    if not home.exists():
        subprocess.run(["hermes", "profile", "create", SMOKE_PROFILE], check=True)
    key = smoke_key()
    llm = cfg["llm"]
    config = render_config(
        llm_base_url=f"http://{llm['host']}:{llm['port']}/v1",
        llm_model=mc.get(cfg, f"llm.profiles.{mc.active_profile(cfg)}.repo"),
        api_port=SMOKE_PORT,
        api_key=key,
        mcp_servers={
            "sa_echo": {
                "command": shutil.which("uv") or "uv",
                "args": ["run", "--project", str(mc.REPO_ROOT), "python", "-m", "sa_infra.mcp_echo"],
                "env": {"SA_ECHO_LOG": str(RUN_DIR / "mcp-echo.log")},
            }
        },
    )
    soul = Template((HERMES_DIR / "SOUL.template.md").read_text(encoding="utf-8")).substitute(
        AGENT_NAME="Smoke",
        OWNER_NAME="the smoke test",
        SOUL="Answer in one short sentence. Use a tool when asked to.",
    )
    write_profile(
        home,
        config=config,
        soul=soul,
        env={
            "API_SERVER_ENABLED": "true",
            "API_SERVER_HOST": "127.0.0.1",
            "API_SERVER_PORT": str(SMOKE_PORT),
            "API_SERVER_KEY": key,
        },
    )
    return home


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args != ["smoke"]:
        print("usage: python -m sa_infra.hermes_profile smoke", file=sys.stderr)
        return 2
    print(smoke())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

`infra/py/tests/test_hermes_profile.py`:

```python
from __future__ import annotations

import yaml

from sa_infra import hermes_profile as hp


def test_render_config_locks_down_toolsets_and_targets_local_llm():
    config = hp.render_config(
        llm_base_url="http://127.0.0.1:8000/v1",
        llm_model="some/model",
        api_port=8700,
        api_key="k",
        mcp_servers={"x": {"command": "c"}},
    )
    assert config["model"] == {
        "provider": "custom",
        "base_url": "http://127.0.0.1:8000/v1",
        "default": "some/model",
        "api_key": "local-no-key",
    }
    assert {"terminal", "file", "code_execution", "browser", "web"} <= set(
        config["agent"]["disabled_toolsets"]
    )
    assert config["gateway"]["api_server"] == {
        "enabled": True,
        "host": "127.0.0.1",
        "port": 8700,
        "key": "k",
    }
    assert config["mcp_servers"] == {"x": {"command": "c"}}
    assert "${" not in yaml.safe_dump(config)
```

### T6: Live smoke suite and first real bring-up

Bring the stack up for real, write the live tests, and fix whatever the real tools disagree with. This is the only task that runs services. It starts after the human steps above. If `make prereqs` fails, report BLOCKED with its output and stop; do not install anything.

T6 runs alone in the last wave, after T1–T5 are merged, so it may also change their files: `infra/py/pyproject.toml`, `uv.lock`, `config/models.yaml`, `infra/hermes/toolsets.yaml`, `infra/hermes/VERSION`, `infra/scripts/up.sh`, `infra/models/start-*.sh`, `infra/py/src/sa_infra/make_fixtures.py`. Those paths are left out of `files` on purpose, because listing them would merge every lane into one. Reviewer: changes to them are in scope when they fix a disagreement with the real tool.

Sequence:
1. Fill the `live` extra in `infra/py/pyproject.toml`: `numpy>=1.26`, `soundfile>=0.12`, `torch>=2.5`, `transformers`, `sentence-transformers>=5.1`, `mlx-audio`, `misaki[en]`, `piper-tts>=1.3`. Run `uv lock`. If two packages conflict on a shared dependency (e.g. `transformers`), keep both packages and loosen or drop the conflicting floor. Note the resolution in `infra/models/README.md`.
2. `make prereqs` → must exit 0. If `infra/hermes/VERSION` still says `unpinned`, run `infra/hermes/pin.sh --pin` (recording only) and commit the file.
3. `make models` (idempotent; resumes the human's downloads).
4. `make up` (profile `fast`). Fix scripts from T3/T4/T5 only where the real tool disagrees. Likely spots: the Hermes foreground command (`hermes -p sa-smoke gateway` vs `gateway run`), whisper-server flag names in the installed version, and the mlx-audio / piper call shapes in `make_fixtures.py`. Keep behavior; change call shapes.
5. Write the live tests below; `make smoke` until green; `make down`.

Live tests in `infra/py/tests/live/`, numbered so the guards run last. Every module sets `pytestmark = pytest.mark.live`. Heavy imports go inside fixtures or tests.

- `conftest.py`: `cfg` (session) = `models_config.load()`; `fixtures_dir` = `models_dir/fixtures`; `texts_dir` = `tests/live/fixtures`. Session-scoped `kokoro_model` and `embedder` fixtures, so both models stay resident until the memory guard runs.
- `test_10_postgres.py`: `docker compose -f infra/docker-compose.yaml exec -T postgres psql -U sa -d sa -tAc "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname='vector'"` → version ≥ 0.8.
- `test_20_llm.py` (httpx, timeout 120 s, `model` = active repo, `temperature` 0). Tools: `get_weather(city: string)`, `add(a: integer, b: integer)`, `search_notes(query: string)`. For the `fast` profile, send `chat_template_kwargs: {"enable_thinking": false}`.
  - "What is 1234 plus 4321? Use a tool." → first tool call is `add`, and the parsed arguments give ints 1234 and 4321.
  - "What's the weather in Geneva right now?" → `get_weather` with "Geneva" in `city`.
  - No tools, "Reply with the single word OK." → content contains `OK` and no `<think>`.
  - If tool calls come back as plain text, set `tool_call_parser: auto` for that profile in `config/models.yaml` and retry before touching anything else.
- `test_30_stt.py`: POST `http://127.0.0.1:8081/inference`, multipart `file`, `response_format=verbose_json`, `temperature=0`. `en_10s.wav` → `wer(reference, text) < 0.15` and detected language `en`. `de.wav` → detected language `de`. If the installed whisper-server returns no `language` field, request it the way that version supports (e.g. `-pc`/`--print-language` flags or the `detect_language` param) and document it.
- `test_40_tts.py`: Kokoro `en` and `fr` (via `make_fixtures.kokoro`) and Piper `de` (via `make_fixtures.piper`) each return finite audio longer than 1.0 s with peak > 0.01.
- `test_50_embeddings.py`: `SentenceTransformer(repo, device="mps", model_kwargs={"torch_dtype": torch.bfloat16}, config_kwargs={"vision_config": None, "audio_config": None})`. Query `When is the delivery deadline?` with the config's `query_prompt`. Docs, formatted with `document_prompt`: an English contract line with the deadline, a French line with the same fact (`La livraison doit avoir lieu au plus tard le 15 mars.`), and an unrelated recipe line. Truncate to `mrl_dim`, re-normalize, then assert: shape `(n, 512)`, all finite, norms within 1e-3 of 1, and both relevant docs score above the recipe.
- `test_60_hermes.py`: `pin.sh --check` exits 0. POST `http://127.0.0.1:8700/v1/chat/completions` with `Authorization: Bearer <.run/hermes-smoke.key>` and `X-Hermes-Session-Id: smoke-<uuid4>`. Message: "Use the add tool to compute 17 + 25 and reply with just the number." → the reply contains `42`, and `.run/mcp-echo.log` has a new line with `a=17, b=25`. A second test asserts no built-in tool is reachable. Read the tool list the pinned version exposes (`GET /v1/capabilities` or the `hermes -p sa-smoke tools` CLI, whichever lists tools) and assert every exposed tool comes from `sa_echo`. Add any built-in toolset this version has and `toolsets.yaml` misses.
- `test_90_guards.py`: pids = `runfiles.service_pids()` ∪ {`os.getpid()`}. Assert {`llm`, `whisper`, `hermes-smoke`} ⊆ pid names, `egress.scan(pids) == []` (on failure, print each `Conn`), and `memguard.check()` ok (print used GiB either way). If Hermes or vllm-mlx phones home (update check, telemetry), turn it off through config or env in the scripts. Never allow-list the address.

`infra/models/README.md`: how to run the stack (prereqs → models → up → smoke), the two profiles and switching (`make up PROFILE=quality` needs `sudo sysctl iogpu.wired_limit_mb=30000`), and the fallbacks: `tool_call_parser: auto`; LM Studio (MLX) if vllm-mlx cannot serve a model, pointed at the same `:8000/v1`; parakeet for meetings. Add a provenance table: repo, revision downloaded, license (from the model card), size on disk. Add measured numbers from this run: used GiB at the guard, LLM time to first token for the `OK` prompt, STT wall time for `en_10s.wav`.

```relay-plan
{
  "slug": "sa-sp0-foundation",
  "suite": "make check",
  "setup": "if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; fi; if [ -f uv.lock ]; then uv sync; fi",
  "tasks": [
    {
      "id": "T1", "title": "Monorepo scaffold and model config", "tier": "cheap", "code": "complete", "risk": "low",
      "files": ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "tsconfig.base.json", "biome.json",
                ".python-version", "pyproject.toml", "uv.lock", "infra/py/pyproject.toml",
                "infra/py/src/sa_infra/__init__.py", "infra/py/src/sa_infra/models_config.py",
                "infra/py/tests/test_models_config.py", "config/models.yaml", "Makefile", ".gitignore",
                ".env.example", "README.md", "AGENTS.md", "CLAUDE.md"],
      "deps": [],
      "behaviors": ["make check passes on a fresh clone with no model and no service",
                    "sa-models resolves the active LLM profile, honoring LLM_PROFILE and failing on an unknown one"],
      "tests": 1,
      "done": "make install && make check"
    },
    {
      "id": "T2", "title": "Egress, memory and WER guards", "tier": "mid", "code": "prose", "risk": "medium",
      "files": ["infra/py/src/sa_infra/runfiles.py", "infra/py/src/sa_infra/egress.py",
                "infra/py/src/sa_infra/memguard.py", "infra/py/src/sa_infra/wer.py",
                "infra/py/tests/test_egress.py", "infra/py/tests/test_memguard.py", "infra/py/tests/test_wer.py"],
      "deps": ["T1"],
      "behaviors": ["non-loopback remotes are flagged, loopback (v4, v6, v4-mapped) is not",
                    "connections of child processes are included in the scan",
                    "memory guard passes at exactly 32 GiB used and fails one byte above",
                    "WER ignores case and punctuation and counts substitutions and deletions"],
      "tests": 4,
      "done": "uv run pytest infra/py/tests/test_egress.py infra/py/tests/test_memguard.py infra/py/tests/test_wer.py"
    },
    {
      "id": "T3", "title": "Prerequisite check, model download, STT fixtures", "tier": "cheap", "code": "complete", "risk": "low",
      "files": ["infra/scripts/prereqs.sh", "infra/models/download.sh", "infra/py/src/sa_infra/make_fixtures.py",
                "infra/py/tests/live/fixtures/en_10s.txt", "infra/py/tests/live/fixtures/de.txt"],
      "deps": ["T1"],
      "behaviors": ["make prereqs lists missing tools with their install command and exits non-zero",
                    "download.sh --dry-run prints every download without network or writes"],
      "tests": 0,
      "done": "bash -n infra/scripts/prereqs.sh infra/models/download.sh && infra/models/download.sh --dry-run | grep -q 'mlx-community/Qwen3.5-9B-8bit' && uv run ruff check infra/py/src/sa_infra/make_fixtures.py"
    },
    {
      "id": "T4", "title": "Stack scripts: LLM, whisper, Postgres, up/down", "tier": "cheap", "code": "complete", "risk": "low",
      "files": ["infra/docker-compose.yaml", "infra/models/start-llm.sh", "infra/models/start-whisper.sh",
                "infra/scripts/up.sh", "infra/scripts/down.sh"],
      "deps": ["T1"],
      "behaviors": ["make up starts each service once and waits for health; a second make up starts nothing new",
                    "make down stops services and their children and removes pidfiles",
                    "profile quality refuses to start without the wired memory limit"],
      "tests": 0,
      "done": "bash -n infra/models/start-llm.sh infra/models/start-whisper.sh infra/scripts/up.sh infra/scripts/down.sh && docker compose -f infra/docker-compose.yaml config -q"
    },
    {
      "id": "T5", "title": "Hermes smoke profile, toolset lockdown, MCP echo server", "tier": "cheap", "code": "complete", "risk": "medium",
      "files": ["infra/hermes/config.template.yaml", "infra/hermes/toolsets.yaml", "infra/hermes/SOUL.template.md",
                "infra/hermes/VERSION", "infra/hermes/pin.sh", "infra/py/src/sa_infra/mcp_echo.py",
                "infra/py/src/sa_infra/hermes_profile.py", "infra/py/tests/test_hermes_profile.py"],
      "deps": ["T1"],
      "behaviors": ["rendered profile points at the local LLM, binds the API server to 127.0.0.1 and disables every built-in toolset"],
      "tests": 1,
      "done": "uv run pytest infra/py/tests/test_hermes_profile.py && bash -n infra/hermes/pin.sh"
    },
    {
      "id": "T6", "title": "Live smoke suite and first real bring-up", "tier": "mid", "code": "prose", "risk": "medium",
      "files": ["infra/py/tests/live/conftest.py",
                "infra/py/tests/live/test_10_postgres.py", "infra/py/tests/live/test_20_llm.py",
                "infra/py/tests/live/test_30_stt.py", "infra/py/tests/live/test_40_tts.py",
                "infra/py/tests/live/test_50_embeddings.py", "infra/py/tests/live/test_60_hermes.py",
                "infra/py/tests/live/test_90_guards.py", "infra/models/README.md"],
      "deps": ["T1", "T2", "T3", "T4", "T5"],
      "behaviors": ["the local LLM picks the right tool with typed arguments among three",
                    "STT transcribes the English fixture with WER < 15% and detects German",
                    "Kokoro (en, fr) and Piper (de) produce more than one second of audio",
                    "EmbeddingGemma 2 returns normalized 512-dim vectors that rank relevant text first, across languages",
                    "Hermes answers through the local LLM using an MCP tool",
                    "the Hermes API server exposes no built-in tool (terminal, file, web, ...)",
                    "pgvector >= 0.8 is available",
                    "no stack process opens a non-loopback connection and system memory stays <= 32 GiB"],
      "tests": 8,
      "done": "make up && make smoke"
    }
  ]
}
```

## After the run (human)

1. `make up && make smoke` once more yourself on profile `fast`.
2. Demo profile: `sudo sysctl iogpu.wired_limit_mb=30000`, then `make down && make up PROFILE=quality && make smoke`. If Gemma 4 tool calls fail even with `tool_call_parser: auto`, the demo stays on `fast` (D-1) and the README records why.
3. Next plan: SP1 (E2E chat). It needs no models, so it can be planned and run while SP0's downloads finish.
