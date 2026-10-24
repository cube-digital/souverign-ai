from __future__ import annotations

from dataclasses import dataclass

import pytest
from sa_memory.rrf import fuse


@dataclass(frozen=True)
class _Hit:
    id: int
    score: float = 0.0
    text: str = ""


def test_fuse_ranks_by_combined_reciprocal_rank() -> None:
    # B is 2nd in both lists, A is 1st only in vectors, C is 1st only in text.
    vector_hits = [_Hit(1), _Hit(2), _Hit(3)]
    text_hits = [_Hit(4), _Hit(2), _Hit(5)]

    fused = fuse(vector_hits, text_hits, k=60, limit=10)

    assert [h.id for h in fused][0] == 2
    assert {h.id for h in fused} == {1, 2, 3, 4, 5}
    # 2 -> 2/(60+2); others at most 1/(60+1)
    assert fused[0].score == pytest.approx(2 / 62)


def test_fuse_respects_limit() -> None:
    fused = fuse([_Hit(1), _Hit(2), _Hit(3)], [_Hit(4)], k=60, limit=2)

    assert len(fused) == 2
