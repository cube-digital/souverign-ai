"""Reciprocal rank fusion of two ranked hit lists, keyed by chunk id."""

from __future__ import annotations

import dataclasses
from typing import Any


def fuse(vector_hits: list[Any], text_hits: list[Any], k: int = 60, limit: int = 5) -> list[Any]:
    scores: dict[Any, float] = {}
    first: dict[Any, Any] = {}
    for hits in (vector_hits, text_hits):
        for rank, h in enumerate(hits, start=1):
            scores[h.id] = scores.get(h.id, 0.0) + 1.0 / (k + rank)
            first.setdefault(h.id, h)
    order = sorted(scores, key=lambda i: scores[i], reverse=True)[:limit]
    return [dataclasses.replace(first[i], score=scores[i]) for i in order]
