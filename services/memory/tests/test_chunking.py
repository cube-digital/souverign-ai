from __future__ import annotations

import pytest
from sa_memory.chunking import chunk


def _sentences(n: int) -> list[str]:
    return [f"Sentence number {i:02d} states distinct fact {i * 7}." for i in range(n)]


def test_chunk_keeps_every_sentence_respects_target_and_carries_overlap() -> None:
    sentences = _sentences(30)
    text = " ".join(sentences)

    chunks = chunk(text, target_chars=300, overlap_chars=100)

    assert len(chunks) >= 3
    assert all(len(c) <= 300 for c in chunks)
    # nothing lost: every sentence appears whole in at least one chunk
    joined = "\n".join(chunks)
    assert all(s in joined for s in sentences)
    # overlap: the last sentence of each chunk reappears at the start of the next one
    last_sentences = [next(s for s in reversed(sentences) if s in c) for c in chunks[:-1]]
    assert all(s in nxt for s, nxt in zip(last_sentences, chunks[1:], strict=True))


def test_chunk_defaults_split_long_paragraphs_text() -> None:
    paragraphs = [f"Paragraph {p} " + ("word " * 500) for p in range(4)]

    chunks = chunk("\n\n".join(paragraphs))

    assert len(chunks) >= 2
    assert all(len(c) <= 3200 for c in chunks)


@pytest.mark.parametrize("blank", ["", "   ", "\n\n \t\n"])
def test_chunk_blank_text_returns_empty_list(blank: str) -> None:
    assert chunk(blank) == []
