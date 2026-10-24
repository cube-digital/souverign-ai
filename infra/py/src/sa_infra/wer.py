from __future__ import annotations

import re
import unicodedata


def normalize(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text).casefold()
    return re.sub(r"[^\w\s]", "", text).split()


def wer(reference: str, hypothesis: str) -> float:
    ref, hyp = normalize(reference), normalize(hypothesis)
    if not ref:
        raise ValueError("reference has no words")
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i]
        for j, h in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h)))
        prev = cur
    return prev[-1] / len(ref)
