from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
import sa_memory
from fastapi.testclient import TestClient
from sa_memory.app import create_app
from sa_memory.embedder import HashEmbedder
from sa_memory.store import PgVectorStore

pytestmark = pytest.mark.pg

DSN = os.environ.get("DATABASE_URL", "postgresql://sa:sa_dev_only@127.0.0.1:5433/sa")
TOKEN = "pg-test-token"
H = {"X-Internal-Token": TOKEN}
NAMESPACES = ("agent:nora", "agent:max", "chat:project")


def _clean() -> None:
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("delete from sa.memory_chunks where namespace = any(%s)", [list(NAMESPACES)])


@pytest.fixture
def client() -> Iterator[TestClient]:
    sql = (Path(sa_memory.__file__).parent / "migrations" / "001_memory.sql").read_text()
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute(sql)
    _clean()
    yield TestClient(create_app(PgVectorStore(DSN), HashEmbedder(), TOKEN))
    _clean()


def _ingest(
    client: TestClient, ns: str, kind: str, origin: str | None, sid: str, ts: float, text: str
) -> int:
    r = client.post(
        "/ingest",
        headers=H,
        json={
            "namespace": ns,
            "kind": kind,
            "origin_chat_id": origin,
            "source": {"type": "doc", "id": sid, "title": sid, "ts": ts},
            "text": text,
        },
    )
    assert r.status_code == 200
    return r.json()["chunks"]


def _recall(client: TestClient, scopes: list[dict]) -> set[str]:
    r = client.post(
        "/recall", headers=H, json={"scopes": scopes, "query": "contract delivery", "k": 8}
    )
    assert r.status_code == 200
    return {hit["source"]["id"] for hit in r.json()["results"]}


def test_recall_returns_only_chunks_inside_the_callers_scopes(client: TestClient) -> None:
    _ingest(client, "agent:nora", "knowledge", None, "nora-private", 10, "contract delivery secret")
    _ingest(client, "agent:nora", "knowledge", "project", "nora-proj", 10, "contract delivery plan")
    _ingest(client, "agent:max", "knowledge", None, "max-owner", 10, "contract delivery owner note")
    _ingest(client, "agent:max", "knowledge", "project", "max-proj", 10, "contract delivery notes")
    _ingest(client, "agent:max", "knowledge", "ops", "max-ops", 10, "contract delivery ops note")
    _ingest(client, "chat:project", "conversation", None, "msg-old", 100, "contract delivery old")
    _ingest(client, "chat:project", "conversation", None, "msg-new", 200, "contract delivery new")

    # Max's scope never reaches agent:nora
    assert _recall(client, [{"namespace": "agent:max"}]) == {"max-owner", "max-proj", "max-ops"}
    # since_ts drops older chat messages
    assert _recall(client, [{"namespace": "chat:project", "since_ts": 150}]) == {"msg-new"}
    # origin_chat_ids drops the ops chunks, null keeps owner-taught ones
    assert _recall(client, [{"namespace": "agent:max", "origin_chat_ids": ["project", None]}]) == {
        "max-owner",
        "max-proj",
    }
    # scopes combine with OR
    assert _recall(
        client,
        [
            {"namespace": "chat:project", "since_ts": 150},
            {"namespace": "agent:max", "origin_chat_ids": ["project"]},
        ],
    ) == {"msg-new", "max-proj"}
    # no scopes, no results
    assert _recall(client, []) == set()


def test_reingesting_a_source_with_fewer_chunks_leaves_exactly_the_new_chunks(
    client: TestClient,
) -> None:
    long_text = "\n\n".join(f"Part {p} " + ("lorem ipsum " * 250) for p in range(4))
    first = _ingest(client, "agent:nora", "knowledge", None, "doc", 1.0, long_text)
    assert first >= 3

    second = _ingest(client, "agent:nora", "knowledge", None, "doc", 2.0, "Short replacement text.")

    assert second == 1
    r = client.post(
        "/recall",
        headers=H,
        json={"scopes": [{"namespace": "agent:nora"}], "query": "replacement", "k": 8},
    )
    results = r.json()["results"]
    assert [(x["chunk_idx"], x["text"]) for x in results] == [(0, "Short replacement text.")]
