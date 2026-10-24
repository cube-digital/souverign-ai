"""Memory store port and its pgvector implementation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np
import psycopg


@dataclass(frozen=True)
class Source:
    type: str
    id: str
    title: str | None
    ts: float


@dataclass(frozen=True)
class Scope:
    namespace: str
    origin_chat_ids: list[str | None] | None = None
    since_ts: float | None = None


@dataclass(frozen=True)
class Hit:
    id: int
    score: float
    text: str
    namespace: str
    kind: str
    source_type: str
    source_id: str
    source_title: str | None
    source_ts: float
    chunk_idx: int


class MemoryStore(Protocol):
    def upsert(
        self,
        namespace: str,
        kind: str,
        origin_chat_id: str | None,
        source: Source,
        chunks: list[str],
        vectors: np.ndarray,
    ) -> int: ...

    def search_vector(self, scopes: list[Scope], vector: np.ndarray, limit: int) -> list[Hit]: ...

    def search_text(self, scopes: list[Scope], query: str, limit: int) -> list[Hit]: ...

    def delete_source(self, namespace: str, source_type: str, source_id: str) -> int: ...


def _vec(v: Any) -> str:
    return "[" + ",".join(f"{float(x):.7g}" for x in v) + "]"


def _scope_sql(scopes: list[Scope]) -> tuple[str, list[Any]]:
    parts: list[str] = []
    params: list[Any] = []
    for s in scopes:
        clause = "namespace = %s"
        params.append(s.namespace)
        if s.origin_chat_ids is not None:
            # "is not distinct from any(...)" is not valid SQL: a null in the list is a flag
            clause += " and (origin_chat_id = any(%s) or (origin_chat_id is null and %s))"
            params.append([o for o in s.origin_chat_ids if o is not None])
            params.append(any(o is None for o in s.origin_chat_ids))
        if s.since_ts is not None:
            clause += " and source_ts >= %s"
            params.append(s.since_ts)
        parts.append(f"({clause})")
    return " or ".join(parts), params


_COLS = "id, text, namespace, kind, source_type, source_id, source_title, source_ts, chunk_idx"


class PgVectorStore:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def _hits(self, rows: list[tuple]) -> list[Hit]:
        return [
            Hit(
                id=r[0], text=r[1], namespace=r[2], kind=r[3], source_type=r[4], source_id=r[5],
                source_title=r[6], source_ts=r[7], chunk_idx=r[8], score=float(r[9]),
            )
            for r in rows
        ]  # fmt: skip

    def upsert(
        self,
        namespace: str,
        kind: str,
        origin_chat_id: str | None,
        source: Source,
        chunks: list[str],
        vectors: np.ndarray,
    ) -> int:
        with psycopg.connect(self._dsn) as conn, conn.transaction():
            for idx, (text, vec) in enumerate(zip(chunks, vectors, strict=True)):
                conn.execute(
                    """
                    insert into sa.memory_chunks
                      (namespace, kind, origin_chat_id, source_type, source_id, source_title,
                       source_ts, chunk_idx, text, embedding)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::vector)
                    on conflict (namespace, source_type, source_id, chunk_idx) do update set
                      kind = excluded.kind, origin_chat_id = excluded.origin_chat_id,
                      source_title = excluded.source_title, source_ts = excluded.source_ts,
                      text = excluded.text, embedding = excluded.embedding
                    """,
                    [namespace, kind, origin_chat_id, source.type, source.id, source.title,
                     source.ts, idx, text, _vec(vec)],
                )  # fmt: skip
            conn.execute(
                "delete from sa.memory_chunks where namespace = %s and source_type = %s "
                "and source_id = %s and chunk_idx >= %s",
                [namespace, source.type, source.id, len(chunks)],
            )
        return len(chunks)

    def search_vector(self, scopes: list[Scope], vector: np.ndarray, limit: int) -> list[Hit]:
        if not scopes:
            return []
        where, params = _scope_sql(scopes)
        q = _vec(vector)
        sql = (
            f"select {_COLS}, 1 - (embedding <=> %s::vector) as score from sa.memory_chunks "
            f"where {where} order by embedding <=> %s::vector limit %s"
        )
        with psycopg.connect(self._dsn) as conn:
            rows = conn.execute(sql, [q, *params, q, limit]).fetchall()
        return self._hits(rows)

    def search_text(self, scopes: list[Scope], query: str, limit: int) -> list[Hit]:
        if not scopes:
            return []
        where, params = _scope_sql(scopes)
        sql = (
            f"select {_COLS}, greatest(ts_rank(tsv_en, plainto_tsquery('english', %s)), "
            f"ts_rank(tsv_simple, plainto_tsquery('simple', %s))) as score "
            f"from sa.memory_chunks where ({where}) and (tsv_en @@ plainto_tsquery('english', %s) "
            f"or tsv_simple @@ plainto_tsquery('simple', %s)) order by score desc, id limit %s"
        )
        with psycopg.connect(self._dsn) as conn:
            rows = conn.execute(sql, [query, query, *params, query, query, limit]).fetchall()
        return self._hits(rows)

    def delete_source(self, namespace: str, source_type: str, source_id: str) -> int:
        with psycopg.connect(self._dsn) as conn:
            cur = conn.execute(
                "delete from sa.memory_chunks where namespace = %s and source_type = %s "
                "and source_id = %s",
                [namespace, source_type, source_id],
            )
            return cur.rowcount
