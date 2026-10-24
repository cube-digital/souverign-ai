from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sa_memory.app import create_app
from sa_memory.embedder import HashEmbedder

TOKEN = "s3cret-token"


class _FakeStore:
    """In-memory store: searches are empty; writes are counted."""

    def __init__(self) -> None:
        self.upserts = 0

    def upsert(self, namespace, kind, origin_chat_id, source, chunks, vectors) -> int:
        self.upserts += 1
        return len(chunks)

    def search_vector(self, scopes, vector, limit) -> list[Any]:
        return []

    def search_text(self, scopes, query, limit) -> list[Any]:
        return []

    def delete_source(self, namespace, source_type, source_id) -> int:
        return 0


@pytest.fixture
def store() -> _FakeStore:
    return _FakeStore()


@pytest.fixture
def client(store: _FakeStore) -> TestClient:
    return TestClient(create_app(store, HashEmbedder(), TOKEN))


RECALL = {"scopes": [{"namespace": "agent:nora"}], "query": "payment terms"}
INGEST = {
    "namespace": "agent:nora",
    "kind": "knowledge",
    "origin_chat_id": None,
    "source": {"type": "doc", "id": "d1", "ts": 1.0},
    "text": "Invoices are paid within 45 days.",
}


def test_routes_require_internal_token_except_healthz(
    client: TestClient, store: _FakeStore
) -> None:
    bad = {"X-Internal-Token": "wrong"}
    delete = {"namespace": "agent:nora", "source_type": "doc", "source_id": "d1"}

    statuses = [
        client.post("/ingest", json=INGEST).status_code,
        client.post("/recall", json=RECALL).status_code,
        client.post("/embed", json={"texts": ["a"], "kind": "query"}).status_code,
        client.request("DELETE", "/sources", json=delete).status_code,
        client.post("/ingest", json=INGEST, headers=bad).status_code,
        client.post("/recall", json=RECALL, headers=bad).status_code,
    ]

    assert statuses == [401, 401, 401, 401, 401, 401]
    assert store.upserts == 0
    assert client.get("/healthz").status_code == 200

    ok = client.post("/ingest", json=INGEST, headers={"X-Internal-Token": TOKEN})
    assert ok.status_code == 200
    assert ok.json() == {"chunks": 1}

    emb = client.post(
        "/embed",
        json={"texts": ["a", "b"], "kind": "document"},
        headers={"X-Internal-Token": TOKEN},
    )
    assert emb.status_code == 200
    assert len(emb.json()["vectors"]) == 2
    assert len(emb.json()["vectors"][0]) == 512


@pytest.mark.parametrize("k", [0, 9, -1])
def test_recall_k_outside_1_to_8_is_422(client: TestClient, k: int) -> None:
    r = client.post("/recall", json={**RECALL, "k": k}, headers={"X-Internal-Token": TOKEN})

    assert r.status_code == 422


@pytest.mark.parametrize("k", [1, 8])
def test_recall_k_boundaries_are_accepted(client: TestClient, k: int) -> None:
    r = client.post("/recall", json={**RECALL, "k": k}, headers={"X-Internal-Token": TOKEN})

    assert r.status_code == 200
    assert r.json() == {"results": []}
