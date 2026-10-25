"""FastAPI surface of the memory service. Only the bridge calls it, with X-Internal-Token."""

from __future__ import annotations

import hmac
import json
import sys
import time
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from sa_memory.chunking import chunk
from sa_memory.embedder import Embedder
from sa_memory.rrf import fuse
from sa_memory.store import MemoryStore, Scope, Source

NAMESPACE = r"^(agent|chat):[A-Za-z0-9_-]+$"
CANDIDATES = 20


class SourceIn(BaseModel):
    type: str
    id: str
    title: str | None = None
    ts: float


class IngestIn(BaseModel):
    namespace: str = Field(pattern=NAMESPACE)
    kind: Literal["conversation", "knowledge", "correction", "meeting"]
    origin_chat_id: str | None = None
    source: SourceIn
    text: str


class ScopeIn(BaseModel):
    namespace: str = Field(pattern=NAMESPACE)
    origin_chat_ids: list[str | None] | None = None
    since_ts: float | None = None


class RecallIn(BaseModel):
    scopes: list[ScopeIn]
    query: str
    k: int = Field(default=5, ge=1, le=8)


class EmbedIn(BaseModel):
    texts: list[str]
    kind: Literal["query", "document"]


class DeleteIn(BaseModel):
    namespace: str = Field(pattern=NAMESPACE)
    source_type: str
    source_id: str
    include_parts: bool = False


def _log(event: str, **fields: int | float | str) -> None:
    print(json.dumps({"event": event, **fields}), file=sys.stdout, flush=True)


def create_app(store: MemoryStore, embedder: Embedder, token: str) -> FastAPI:
    app = FastAPI(title="sa-memory")

    def auth(x_internal_token: Annotated[str | None, Header()] = None) -> None:
        if x_internal_token is None or not hmac.compare_digest(x_internal_token, token):
            raise HTTPException(status_code=401, detail="unauthorized")

    guard = [Depends(auth)]

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True, "model_loaded": bool(getattr(embedder, "loaded", False))}

    @app.post("/ingest", dependencies=guard)
    def ingest(body: IngestIn) -> dict:
        t0 = time.perf_counter()
        parts = chunk(body.text)
        vectors = embedder.embed(parts, "document", [body.source.title] * len(parts))
        src = Source(body.source.type, body.source.id, body.source.title, body.source.ts)
        n = store.upsert(body.namespace, body.kind, body.origin_chat_id, src, parts, vectors)
        _log("ingest", chunks=n, ms=round((time.perf_counter() - t0) * 1000))
        return {"chunks": n}

    @app.post("/recall", dependencies=guard)
    def recall(body: RecallIn) -> dict:
        t0 = time.perf_counter()
        for sc in body.scopes:
            if sc.namespace.startswith("agent:") and "origin_chat_ids" not in sc.model_fields_set:
                raise HTTPException(422, "agent scopes must state origin_chat_ids (null = all)")
        scopes = [Scope(s.namespace, s.origin_chat_ids, s.since_ts) for s in body.scopes]
        if not scopes:
            return {"results": []}
        qvec = embedder.embed([body.query], "query")[0]
        vec_hits = store.search_vector(scopes, qvec, CANDIDATES)
        txt_hits = store.search_text(scopes, body.query, CANDIDATES)
        hits = fuse(vec_hits, txt_hits, k=60, limit=body.k)
        _log("recall", results=len(hits), ms=round((time.perf_counter() - t0) * 1000))
        return {
            "results": [
                {
                    "text": h.text,
                    "score": h.score,
                    "space": h.namespace,
                    "kind": h.kind,
                    "source": {
                        "type": h.source_type,
                        "id": h.source_id,
                        "title": h.source_title,
                        "ts": h.source_ts,
                    },
                    "chunk_idx": h.chunk_idx,
                    "origin_chat_id": h.origin_chat_id,
                }
                for h in hits
            ]
        }

    @app.post("/embed", dependencies=guard)
    def embed(body: EmbedIn) -> dict:
        vectors = embedder.embed(body.texts, body.kind)
        return {"vectors": vectors.tolist()}

    @app.delete("/sources", dependencies=guard)
    def delete_sources(body: DeleteIn) -> dict:
        extra = {"include_parts": True} if body.include_parts else {}
        return {
            "deleted": store.delete_source(
                body.namespace, body.source_type, body.source_id, **extra
            )
        }

    return app
