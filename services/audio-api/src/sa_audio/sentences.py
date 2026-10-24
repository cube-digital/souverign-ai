from __future__ import annotations

import re

_ABBREVIATIONS = {
    "e.g.", "i.e.", "dr.", "mr.", "mrs.", "ms.", "prof.", "vs.", "etc.", "z.b.", "p.", "pp.",
    "no.", "st.",
}  # fmt: skip
_TERMINATORS = ".!?…"


def _is_boundary(text: str, i: int) -> bool:
    ch = text[i]
    if ch == "\n":
        return True
    if ch not in _TERMINATORS:
        return False
    nxt = text[i + 1] if i + 1 < len(text) else ""
    if ch != "." and nxt in _TERMINATORS:
        return False  # "?!" or "..." : split after the last one
    if nxt and not nxt.isspace() and nxt not in "\"')]”’»":
        return False  # "3.5", "example.com"
    if ch == ".":
        word = re.search(r"(\S+)$", text[: i + 1])
        token = word.group(1).lower() if word else ""
        token = token.lstrip("(\"'[“‘«")
        if token in _ABBREVIATIONS or re.fullmatch(r"(?:[a-z]\.)+", token):
            return False  # abbreviation, or initials such as "J." / "U.S."
    return True


def split(text: str) -> list[str]:
    """Split text into sentences on . ! ? … and newlines, keeping decimals and abbreviations."""
    pieces: list[str] = []
    start = 0
    for i in range(len(text)):
        if _is_boundary(text, i):
            pieces.append(text[start : i + 1])
            start = i + 1
    pieces.append(text[start:])
    return [p.strip() for p in pieces if p.strip()]
