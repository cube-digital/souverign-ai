from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest
import sa_memory
from fastapi.testclient import TestClient
from sa_memory.app import create_app
from sa_memory.embedder import HashEmbedder
from sa_memory.store import Hit, PgVectorStore

TOKEN = "origin-parts-token"
H = {"X-Internal-Token": TOKEN}
DSN = os.environ.get("DATABASE_URL", "postgresql://sa:sa_dev_only@127.0.0.1:5433/sa")
NS = "agent:originparts"


class _RecordingStore:
    """Fake store: returns canned hits and records delete calls (kwargs preserved)."""

    def __init__(self, hits: list[Hit]) -> None:
        self.hits = hits
        self.deletes: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def upsert(self, namespace, kind, origin_chat_id, source, chunks, vectors) -> int:
        return len(chunks)

    def search_vector(self, scopes, vector, limit) -> list[Hit]:
        return self.hits

    def search_text(self, scopes, query, limit) -> list[Hit]:
        return []

    def delete_source(self, namespace, source_type, source_id, **kw) -> int:
        self.deletes.append(((namespace, source_type, source_id), kw))
        return 0


def _hit(hit_id: int, origin: str | None) -> Hit:
    return Hit(
        id=hit_id,
        score=0.0,
        text=f"text {hit_id}",
        namespace="agent:nora",
        kind="knowledge",
        source_type="doc",
        source_id=f"d{hit_id}",
        source_title=None,
        source_ts=1.0,
        chunk_idx=0,
        origin_chat_id=origin,
    )


def test_recall_results_carry_origin_chat_id() -> None:
    store = _RecordingStore([_hit(1, "chat-a"), _hit(2, None)])
    client = TestClient(create_app(store, HashEmbedder(), TOKEN))

    r = client.post(
        "/recall",
        headers=H,
        json={"scopes": [{"namespace": "agent:nora", "origin_chat_ids": None}], "query": "anything", "k": 8},
    )

    assert r.status_code == 200
    by_id = {x["source"]["id"]: x["origin_chat_id"] for x in r.json()["results"]}
    assert by_id == {"d1": "chat-a", "d2": None}


def test_include_parts_is_forwarded_only_when_set() -> None:
    store = _RecordingStore([])
    client = TestClient(create_app(store, HashEmbedder(), TOKEN))
    body = {"namespace": "agent:nora", "source_type": "doc", "source_id": "d1"}

    plain = client.request("DELETE", "/sources", headers=H, json=body)
    parts = client.request("DELETE", "/sources", headers=H, json={**body, "include_parts": True})

    assert plain.status_code == 200
    assert parts.status_code == 200
    key = ("agent:nora", "doc", "d1")
    assert store.deletes == [(key, {}), (key, {"include_parts": True})]


@pytest.fixture
def pg_client() -> Iterator[TestClient]:
    sql = (Path(sa_memory.__file__).parent / "migrations" / "001_memory.sql").read_text()
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute(sql)
        conn.execute("delete from sa.memory_chunks where namespace = %s", [NS])
    yield TestClient(create_app(PgVectorStore(DSN), HashEmbedder(), TOKEN))
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("delete from sa.memory_chunks where namespace = %s", [NS])


@pytest.mark.pg
def test_delete_with_parts_removes_dotted_parts_but_not_prefix_siblings(
    pg_client: TestClient,
) -> None:
    for sid in ("doc1", "doc1.p1", "doc1.p2", "doc10"):
        r = pg_client.post(
            "/ingest",
            headers=H,
            json={
                "namespace": NS,
                "kind": "knowledge",
                "origin_chat_id": None,
                "source": {"type": "doc", "id": sid, "ts": 1.0},
                "text": f"contract delivery {sid}",
            },
        )
        assert r.status_code == 200

    def remaining() -> set[str]:
        with psycopg.connect(DSN) as conn:
            rows = conn.execute(
                "select distinct source_id from sa.memory_chunks where namespace = %s", [NS]
            ).fetchall()
        return {row[0] for row in rows}

    body = {"namespace": NS, "source_type": "doc", "source_id": "doc1"}
    pg_client.request("DELETE", "/sources", headers=H, json=body)
    assert remaining() == {"doc1.p1", "doc1.p2", "doc10"}

    pg_client.request("DELETE", "/sources", headers=H, json={**body, "include_parts": True})
    assert remaining() == {"doc10"}
