# AI Services Plan: memory and audio (SP3 core + SP5 core)

**Goal:** two standalone local services, ready for the bridge to call in SP2–SP5: `memory` (ingest, hybrid recall with citations under the D-9 scope rules, embeddings) and `audio-api` (speech-to-text through whisper.cpp, text-to-speech routed by language).
**Spec:** docs/superpowers/specs/2026-10-24-sovereign-agents-demo-design.md (§4 A5, §7 `memory_chunks`, §8.4, §8.5, amendments 1–3 and 13) + docs/superpowers/specs/decisions.md (D-9).
**Architecture:** two FastAPI apps in the uv workspace (`services/memory` → package `sa_memory`, port 8646; `services/audio-api` → package `sa_audio`, port 8645), reading model ids from `config/models.yaml` through `sa_infra.models_config`. Heavy model libraries sit behind small adapter classes that load lazily, so unit tests run with fakes and `make check` stays model-free. This plan runs in parallel with SP1 and shares no file with it.

## Global Constraints

- Python 3.12, ruff (`E,F,I,B,UP`, line 100), `from __future__ import annotations` in every module. Run `uv run ruff format` and `uv run ruff check --fix` before each commit.
- After S1, tasks add files under `services/<svc>/src` and `services/<svc>/tests` only. They never touch `pyproject.toml` or `uv.lock`; if a dependency is missing, stop with NEEDS_CONTEXT.
- Test markers: plain unit tests run in `make check`. `pg` needs the Docker Postgres (`docker compose -f infra/docker-compose.yaml up -d --wait postgres`, `127.0.0.1:5433`). `live` loads real models from the local cache (`uv run --group live …`, `HF_HUB_OFFLINE=1`). Live tests import heavy libraries inside the test.
- Both services bind 127.0.0.1 and require `X-Internal-Token` (env `MEMORY_TOKEN` / `AUDIO_TOKEN`; exit at startup if unset). Only the bridge calls them.
- Logs: one JSON object per line; never log text, transcripts, audio or vectors (counts, sizes, latencies only).
- No network at runtime: models come from the HF cache and `SA_MODELS_DIR` filled by `make models`.
- Do not start the LLM (vllm-mlx) in this plan. Only the embedding model and the TTS engines load, in-process, inside live tests.
- Commit messages `feat(services): …`, one per task.

## Review Focus

- The recall query can only return chunks matching the scopes the caller passed. A missing or empty scope list returns nothing, never everything.
- Re-ingesting a source replaces its chunks (no duplicates, no leftovers when it shrinks).
- The embeddings are 512-dim, re-normalized after truncation, computed in bfloat16 (never float16) and finite.
- TTS falls back to English Kokoro for unknown languages, and no request triggers a model download.

## Tasks

### S1: Workspace members and dependencies

Replace the root `pyproject.toml` with:

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
members = ["infra/py", "services/memory", "services/audio-api"]

[tool.uv.sources]
sa-infra = { workspace = true }
sa-memory = { workspace = true }
sa-audio = { workspace = true }

[dependency-groups]
dev = ["pytest>=8.3", "ruff>=0.6", "sa-infra", "sa-memory", "sa-audio"]
live = ["sa-infra[live]", "sa-memory[models]", "sa-audio[models]"]

[tool.ruff]
line-length = 100
extend-exclude = ["docs"]
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]

[tool.pytest.ini_options]
addopts = "-q --import-mode=importlib -m 'not live and not pg'"
markers = [
  "live: loads real models or needs the running local stack (make models, make up)",
  "pg: needs the Docker Postgres on 127.0.0.1:5433",
]
testpaths = ["infra/py/tests", "services/memory/tests", "services/audio-api/tests"]
```

`services/memory/pyproject.toml`:

```toml
[project]
name = "sa-memory"
version = "0.0.0"
description = "Sovereign Agents memory: ingest, hybrid recall with citations, embeddings"
requires-python = ">=3.12,<3.14"
dependencies = [
  "sa-infra",
  "fastapi>=0.115",
  "uvicorn>=0.30",
  "pydantic>=2.8",
  "psycopg[binary]>=3.2",
  "numpy>=1.26",
]

[project.optional-dependencies]
models = ["torch>=2.5", "transformers", "sentence-transformers>=5.1", "pillow", "torchvision"]

[project.scripts]
sa-memory = "sa_memory.main:run"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/sa_memory"]

[tool.uv.sources]
sa-infra = { workspace = true }
```

`services/audio-api/pyproject.toml`:

```toml
[project]
name = "sa-audio"
version = "0.0.0"
description = "Sovereign Agents audio API: STT through whisper.cpp, TTS routed by language"
requires-python = ">=3.12,<3.14"
dependencies = [
  "sa-infra",
  "fastapi>=0.115",
  "uvicorn>=0.30",
  "pydantic>=2.8",
  "httpx>=0.27",
  "python-multipart>=0.0.9",
  "numpy>=1.26",
  "soundfile>=0.12",
]

[project.optional-dependencies]
models = ["mlx-audio", "misaki[en]", "piper-tts>=1.3"]

[project.scripts]
sa-audio = "sa_audio.main:run"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/sa_audio"]

[tool.uv.sources]
sa-infra = { workspace = true }
```

`services/memory/src/sa_memory/__init__.py`: `"""Sovereign Agents memory service."""`. `services/audio-api/src/sa_audio/__init__.py`: `"""Sovereign Agents audio API."""`. Then `uv lock && uv sync` and commit `uv.lock`. If `uv lock` reports a conflict between the new extras and `sa-infra[live]`, loosen the floor that conflicts and note it in the commit message.

### S2: Memory service

Package `sa_memory`, FastAPI on `MEMORY_HOST`:`MEMORY_PORT` (default 127.0.0.1:8646), `DATABASE_URL` (default `postgresql://sa:sa_dev_only@127.0.0.1:5433/sa`).

Modules:
- `config.py`: reads `embeddings` from `config/models.yaml` (`repo`, `mrl_dim`, `query_prompt`, `document_prompt`, `dtype`, `device`).
- `embedder.py`: `class Embedder(Protocol): def embed(self, texts: list[str], kind: Literal["query", "document"], titles: list[str | None] | None = None) -> np.ndarray` (shape `(n, 512)`, float32, rows L2-normalized). `EmbeddingGemma` loads lazily: `SentenceTransformer(repo, device="mps", model_kwargs={"torch_dtype": torch.bfloat16}, config_kwargs={"vision_config": None, "audio_config": None})`. Query text gets `query_prompt`; documents get `title: {title or "none"} | text: …`. It truncates to `mrl_dim` and re-normalizes. `HashEmbedder` is a deterministic fake for tests (seeded by a hash of the text).
- `chunking.py`: `chunk(text: str, target_chars=3200, overlap_chars=400) -> list[str]`. It splits on paragraphs, then sentences, and packs up to the target with the overlap carried over. Characters approximate the spec's 800 tokens / 100 overlap (documented approximation); empty or whitespace-only input → `[]`.
- `migrations/001_memory.sql`, applied at startup via `sa.memory_migrations(version text primary key, applied_at timestamptz default now())`:

```sql
create extension if not exists vector;
create schema if not exists sa;
create table if not exists sa.memory_chunks (
  id bigserial primary key,
  namespace text not null check (namespace ~ '^(agent|chat):[A-Za-z0-9_-]+$'),
  kind text not null check (kind in ('conversation', 'knowledge', 'correction', 'meeting')),
  origin_chat_id text,
  source_type text not null,
  source_id text not null,
  source_title text,
  source_ts double precision not null,
  chunk_idx int not null,
  text text not null,
  tsv_en tsvector generated always as (to_tsvector('english', text)) stored,
  tsv_simple tsvector generated always as (to_tsvector('simple', text)) stored,
  embedding vector(512) not null,
  created_at timestamptz not null default now(),
  unique (namespace, source_type, source_id, chunk_idx)
);
create index if not exists memory_chunks_embedding on sa.memory_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists memory_chunks_tsv_en on sa.memory_chunks using gin (tsv_en);
create index if not exists memory_chunks_tsv_simple on sa.memory_chunks using gin (tsv_simple);
create index if not exists memory_chunks_scope on sa.memory_chunks (namespace, origin_chat_id, source_ts);
```

- `store.py`: `class MemoryStore(Protocol)` with `upsert(namespace, kind, origin_chat_id, source, chunks, vectors) -> int`, `search_vector(scopes, vector, limit) -> list[Hit]`, `search_text(scopes, query, limit) -> list[Hit]`, `delete_source(namespace, source_type, source_id) -> int`. The port exists so another backend (D-6: Couchbase Lite on device) can be added later. `PgVectorStore` implements it with psycopg. Vectors are passed as `'[…]'::vector`. `upsert` runs in one transaction: upsert each chunk index, then delete indices ≥ the new chunk count for that source. Text rank = `greatest(ts_rank(tsv_en, plainto_tsquery('english', q)), ts_rank(tsv_simple, plainto_tsquery('simple', q)))`, only rows matching either query. Each scope compiles to `(namespace = %s [and origin_chat_id is not distinct from any(…)] [and source_ts >= %s])`, joined with `or`. An empty scope list returns `[]` without querying.
- `rrf.py`: `fuse(vector_hits, text_hits, k=60, limit) -> list[Hit]` (reciprocal rank fusion by chunk id; score = Σ 1/(k + rank)).
- `app.py`: `create_app(store, embedder, token) -> FastAPI`. Every route except `/healthz` requires `X-Internal-Token` (401).
  - `POST /ingest {namespace, kind, origin_chat_id: str | null, source: {type, id, title?, ts}, text}` → `{chunks: n}`.
  - `POST /recall {scopes: [{namespace, origin_chat_ids?: [str | null], since_ts?: float}], query, k: 1..8 = 5}` → `{results: [{text, score, space: namespace, kind, source: {type, id, title, ts}, chunk_idx}]}`: vector top 20 + text top 20, fused, top k.
  - `POST /embed {texts: [str], kind}` → `{vectors}`. `DELETE /sources {namespace, source_type, source_id}` → `{deleted}`. `GET /healthz` → `{ok, model_loaded}`.
- `main.py`: `run()` builds the real store and `EmbeddingGemma`, applies the migration, runs uvicorn.

Tests (`services/memory/tests/`):
- unit: `chunk` keeps every sentence, respects the target, carries the overlap, and returns `[]` for blank text;
- unit: `fuse` orders by combined reciprocal rank (a chunk ranked 2nd in both lists beats one ranked 1st in only one);
- unit (`HashEmbedder` + in-memory fake store): routes need the token, and `k` outside 1..8 is a 422;
- `pg`: with chunks in `agent:nora`, `agent:max` and `chat:project` (some with `origin_chat_id` `project`, some `ops`, some null): a scope list for Max returns nothing from `agent:nora`; `since_ts` drops older chat messages; `origin_chat_ids: ["project", null]` drops the `ops` chunks; an empty scope list returns nothing;
- `pg`: re-ingesting a source with fewer chunks leaves exactly the new chunks;
- `live`: the recall eval. Add `tests/eval/corpus.jsonl` (20 short passages from a fictional supplier contract, delivery policy and meeting notes; 15 English, 5 French or German, each with an `id` and `title`) and `tests/eval/questions.jsonl` (40 questions: 30 English, 10 French/German, each with the expected passage id). Ingest into a temp namespace with `EmbeddingGemma`. Recall@3 must be ≥ 0.8. If it is lower, the test fails and its message names the fallback (`Qwen/Qwen3-Embedding-0.6B`, a human decision).

### S3: Audio API

Package `sa_audio`, FastAPI on `AUDIO_HOST`:`AUDIO_PORT` (default 127.0.0.1:8645), whisper-server at `http://{stt.host}:{stt.port}` from `config/models.yaml`.

Modules:
- `stt.py`: `async def transcribe(client: httpx.AsyncClient, base_url, audio: bytes, filename, language: str = "auto") -> Transcript` posts multipart `file`, `response_format=verbose_json`, `temperature=0`, `language` to `/inference`. It maps the reply to `Transcript {text, language, duration, segments: [{start, end, text}]}`, with the text trimmed.
- `sentences.py`: `split(text: str) -> list[str]` on `.`, `!`, `?`, `…` and newlines. It does not split on decimals (`3.5`), common abbreviations (`e.g.`, `i.e.`, `Dr.`, `Mr.`, `Mrs.`, `vs.`, `etc.`, `z.B.`, `p.`), or initials. It drops empty pieces.
- `tts.py`: `class TtsEngine(Protocol): sample_rate: int; def synth(self, text: str) -> np.ndarray` (float32 mono). `KokoroEngine(lang_code, voice)` shares one lazily loaded `mlx_audio` model (`tts.kokoro.repo`). `PiperEngine(voice_path)` loads the `.onnx` from `SA_MODELS_DIR/piper/`. `class Router` maps languages: `en`/`fr`/`es`/`it` → Kokoro with `tts.kokoro.languages[lang]`, `de`/`ro` → Piper with `tts.piper.voices[lang]`; anything else, or empty → English Kokoro. Engines are cached per language. `voice` may override the Kokoro voice name.
- `app.py`: `create_app(router, stt_base_url, token, http_client=None) -> FastAPI`. All routes but `/healthz` need `X-Internal-Token`.
  - `POST /v1/audio/transcriptions` (multipart `file`, `language` = `auto`) → `Transcript` JSON; whisper unreachable → 503 `{error: "stt_unavailable"}`.
  - `POST /v1/audio/speech {input (1..4000 chars), language = "en", voice?, stream = false}`. Without `stream`: one WAV (`audio/wav`) of all sentences. With `stream`: `application/x-ndjson`, one line per sentence as soon as it is synthesized: `{"seq", "text", "sample_rate", "wav_b64"}` (base64 standard). Synthesis runs in a worker thread so the event loop keeps serving.
  - `GET /v1/voices` → languages with engine and voice. `GET /healthz` → `{ok}`.
- `main.py`: `run()` builds the real router and serves with uvicorn.

Tests (`services/audio-api/tests/`). Five tests stand although the risk is low: each covers a behavior the bridge relies on in SP5, and none needs a model except the last.
- unit: `split` keeps `3.5`, `e.g.`, `Dr. Popescu` and `p. 3` intact and splits three plain sentences into three;
- unit: the router picks Piper for `de` and `ro`, Kokoro for `fr`, and English Kokoro for `pt` or empty (fake engines);
- unit: the transcription route maps a whisper `verbose_json` reply (mocked with `httpx.MockTransport`) and returns 503 when the transport raises a connect error;
- unit: with a fake engine, `stream=true` returns one NDJSON line per sentence, in order;
- `live`: real engines produce more than 1 s of finite audio for an English (Kokoro) and a German (Piper) sentence, with `HF_HUB_OFFLINE=1`.

```relay-plan
{
  "slug": "sa-ai-services",
  "suite": "uv run ruff check . && uv run ruff format --check . && uv run pytest",
  "setup": "uv sync",
  "tasks": [
    {
      "id": "S1", "title": "Workspace members and dependencies", "tier": "cheap", "code": "complete", "risk": "low",
      "files": ["pyproject.toml", "uv.lock", "services/memory/pyproject.toml", "services/audio-api/pyproject.toml",
                "services/memory/src/sa_memory/__init__.py", "services/audio-api/src/sa_audio/__init__.py"],
      "deps": [],
      "behaviors": ["both services install in the uv workspace and make check still passes without models"],
      "tests": 0,
      "done": "uv lock && uv sync && uv run python -c 'import sa_memory, sa_audio' && uv run pytest"
    },
    {
      "id": "S2", "title": "Memory service", "tier": "mid", "code": "prose", "risk": "medium",
      "files": ["services/memory/src/sa_memory/config.py", "services/memory/src/sa_memory/embedder.py",
                "services/memory/src/sa_memory/chunking.py", "services/memory/src/sa_memory/store.py",
                "services/memory/src/sa_memory/rrf.py", "services/memory/src/sa_memory/app.py",
                "services/memory/src/sa_memory/main.py", "services/memory/src/sa_memory/migrations/001_memory.sql",
                "services/memory/tests/test_chunking.py", "services/memory/tests/test_rrf.py",
                "services/memory/tests/test_memory_app.py", "services/memory/tests/test_pg_store.py",
                "services/memory/tests/test_recall_eval.py", "services/memory/tests/eval/corpus.jsonl",
                "services/memory/tests/eval/questions.jsonl"],
      "deps": ["S1"],
      "behaviors": ["documents are chunked with overlap and nothing is lost",
                    "recall fuses vector and full-text ranking",
                    "the internal token is required and bad parameters are refused",
                    "recall returns only chunks inside the caller's scopes (D-9), and nothing for no scopes",
                    "re-ingesting a source replaces its chunks",
                    "recall@3 >= 0.8 on the English + French/German eval set"],
      "tests": 6,
      "done": "docker compose -f infra/docker-compose.yaml up -d --wait postgres && uv run pytest services/memory/tests && uv run pytest -m pg services/memory/tests && HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 uv run --group live pytest -m live services/memory/tests"
    },
    {
      "id": "S3", "title": "Audio API", "tier": "mid", "code": "prose", "risk": "low",
      "files": ["services/audio-api/src/sa_audio/stt.py", "services/audio-api/src/sa_audio/sentences.py",
                "services/audio-api/src/sa_audio/tts.py", "services/audio-api/src/sa_audio/app.py",
                "services/audio-api/src/sa_audio/main.py", "services/audio-api/tests/test_sentences.py",
                "services/audio-api/tests/test_router.py", "services/audio-api/tests/test_audio_app.py",
                "services/audio-api/tests/test_live_tts.py"],
      "deps": ["S1"],
      "behaviors": ["sentences split without breaking decimals and abbreviations",
                    "speech is routed by language with an English fallback",
                    "transcription proxies whisper.cpp and reports when it is down",
                    "streaming speech sends one chunk per sentence, in order",
                    "real Kokoro and Piper voices speak English and German offline"],
      "tests": 5,
      "done": "uv run pytest services/audio-api/tests && HF_HUB_OFFLINE=1 uv run --group live pytest -m live services/audio-api/tests"
    }
  ]
}
```

## After the run (human)

- If the recall eval fails, decide on the embedding fallback (`Qwen/Qwen3-Embedding-0.6B`, 1024 dims, a schema change).
- Wiring into the bridge, Makefile targets and `make up` happen in SP2–SP5.
