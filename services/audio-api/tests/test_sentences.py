from __future__ import annotations

from sa_audio.sentences import split


def test_split_keeps_decimals_and_abbreviations_and_splits_plain_sentences() -> None:
    assert split("It costs 3.5 euros.") == ["It costs 3.5 euros."]
    assert split("Use fruit, e.g. apples, daily.") == ["Use fruit, e.g. apples, daily."]
    assert split("Ask Dr. Popescu today.") == ["Ask Dr. Popescu today."]
    assert split("See p. 3 for details.") == ["See p. 3 for details."]
    assert split("One. Two! Three?") == ["One.", "Two!", "Three?"]
