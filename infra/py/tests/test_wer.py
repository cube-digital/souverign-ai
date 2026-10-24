from __future__ import annotations

import pytest
from sa_infra.wer import wer


def test_wer_ignores_case_punctuation_and_counts_edits() -> None:
    assert wer("Hello, World! It's me.", "hello world its ME") == 0.0
    assert wer("the cat sat down", "the cat sat town") == 0.25
    assert wer("a b c d", "a b d") == 0.25
    with pytest.raises(ValueError):
        wer("", "anything")
