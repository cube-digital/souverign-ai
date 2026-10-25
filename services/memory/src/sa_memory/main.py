"""Entry point: real store, EmbeddingGemma, migration, uvicorn on 127.0.0.1."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import psycopg
import uvicorn

from sa_memory.app import create_app
from sa_memory.embedder import EmbeddingGemma
from sa_memory.store import PgVectorStore

DEFAULT_DSN = "postgresql://sa:sa_dev_only@127.0.0.1:5433/sa"
MIGRATIONS = Path(__file__).parent / "migrations"


def migrate(dsn: str) -> None:
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("create schema if not exists sa")
        conn.execute(
            "create table if not exists sa.memory_migrations "
            "(version text primary key, applied_at timestamptz default now())"
        )
        for f in sorted(MIGRATIONS.glob("*.sql")):
            if conn.execute(
                "select 1 from sa.memory_migrations where version = %s", [f.stem]
            ).fetchone():
                continue
            with conn.transaction():
                conn.execute(f.read_text())
                conn.execute("insert into sa.memory_migrations (version) values (%s)", [f.stem])


def run() -> None:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    token = os.environ.get("MEMORY_TOKEN")
    if not token:
        print("MEMORY_TOKEN is not set", file=sys.stderr)
        raise SystemExit(1)
    dsn = os.environ.get("DATABASE_URL", DEFAULT_DSN)
    migrate(dsn)
    if importlib.util.find_spec("sentence_transformers") is None:
        print(
            "sa-memory: embeddings UNAVAILABLE (torch/sentence-transformers not installed); "
            "teach and ingest will fail. Start with: "
            "uv run --package sa-memory --extra models sa-memory",
            file=sys.stderr,
            flush=True,
        )
    app = create_app(PgVectorStore(dsn), EmbeddingGemma(), token)
    uvicorn.run(
        app,
        host=os.environ.get("MEMORY_HOST", "127.0.0.1"),
        port=int(os.environ.get("MEMORY_PORT", "8646")),
        log_config=None,
    )
