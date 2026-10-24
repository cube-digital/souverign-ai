from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest

pytestmark = [pytest.mark.live, pytest.mark.pg]

EVAL = Path(__file__).parent / "eval"
DSN = os.environ.get("DATABASE_URL", "postgresql://sa:sa_dev_only@127.0.0.1:5433/sa")
TOKEN = "eval-token"
THRESHOLD = 0.8


def _load(name: str) -> list[dict]:
    return [json.loads(line) for line in (EVAL / name).read_text().splitlines() if line.strip()]


def test_recall_at_3_on_english_french_german_eval_set() -> None:
    import psycopg
    from fastapi.testclient import TestClient
    from sa_memory.app import create_app
    from sa_memory.embedder import EmbeddingGemma
    from sa_memory.store import PgVectorStore

    corpus = _load("corpus.jsonl")
    questions = _load("questions.jsonl")
    assert len(corpus) == 20
    assert len(questions) == 40

    ns = f"agent:eval_{uuid.uuid4().hex[:8]}"
    headers = {"X-Internal-Token": TOKEN}
    client = TestClient(create_app(PgVectorStore(DSN), EmbeddingGemma(), TOKEN))
    try:
        for i, p in enumerate(corpus):
            r = client.post(
                "/ingest",
                headers=headers,
                json={
                    "namespace": ns,
                    "kind": "knowledge",
                    "origin_chat_id": None,
                    "source": {"type": "doc", "id": p["id"], "title": p["title"], "ts": float(i)},
                    "text": p["text"],
                },
            )
            assert r.status_code == 200

        def hit(q: dict) -> bool:
            r = client.post(
                "/recall",
                headers=headers,
                json={"scopes": [{"namespace": ns}], "query": q["question"], "k": 3},
            )
            return q["expected_id"] in [x["source"]["id"] for x in r.json()["results"]]

        recall = sum(hit(q) for q in questions) / len(questions)
    finally:
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("delete from sa.memory_chunks where namespace = %s", [ns])

    assert recall >= THRESHOLD, (
        f"recall@3 = {recall:.3f} < {THRESHOLD}: switch the embedding model to the fallback "
        "Qwen/Qwen3-Embedding-0.6B (a human decision, do not switch silently)"
    )
