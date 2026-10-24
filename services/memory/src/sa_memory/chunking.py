"""Paragraph/sentence chunking with overlap.

Characters approximate the spec's 800 tokens / 100 overlap (about 4 chars per token).
"""

from __future__ import annotations

import re

_SENTENCE = re.compile(r"(?<=[.!?])\s+")


def _units(text: str, target: int) -> list[str]:
    """Paragraphs, falling back to sentences, then hard splits, each at most `target`."""
    out: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if len(para) <= target:
            out.append(para)
            continue
        for sent in _SENTENCE.split(para):
            sent = sent.strip()
            while len(sent) > target:
                cut = sent.rfind(" ", 0, target)
                cut = cut if cut > 0 else target
                out.append(sent[:cut].strip())
                sent = sent[cut:].strip()
            if sent:
                out.append(sent)
    return out


def chunk(text: str, target_chars: int = 3200, overlap_chars: int = 400) -> list[str]:
    units = _units(text, target_chars)
    if not units:
        return []
    chunks: list[str] = []
    cur: list[str] = []

    def size(parts: list[str]) -> int:
        return len(" ".join(parts))

    for u in units:
        if cur and size([*cur, u]) > target_chars:
            chunks.append(" ".join(cur))
            carry: list[str] = []
            for prev in reversed(cur):
                if size([prev, *carry, u]) > target_chars or size([prev, *carry]) > overlap_chars:
                    break
                carry.insert(0, prev)
            cur = carry
        cur.append(u)
    chunks.append(" ".join(cur))
    return chunks
