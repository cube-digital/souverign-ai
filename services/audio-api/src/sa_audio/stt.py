from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel


class Segment(BaseModel):
    start: float
    end: float
    text: str


class Transcript(BaseModel):
    text: str
    language: str
    duration: float
    segments: list[Segment]


async def transcribe(
    client: httpx.AsyncClient,
    base_url: str,
    audio: bytes,
    filename: str,
    language: str = "auto",
) -> Transcript:
    """Proxy one audio file to whisper.cpp's /inference and map the verbose_json reply."""
    resp = await client.post(
        f"{base_url.rstrip('/')}/inference",
        files={"file": (filename, audio)},
        data={"response_format": "verbose_json", "temperature": "0", "language": language},
    )
    resp.raise_for_status()
    body: dict[str, Any] = resp.json()
    segments = [
        Segment(
            start=float(s.get("start", 0.0)),
            end=float(s.get("end", 0.0)),
            text=str(s.get("text", "")).strip(),
        )
        for s in body.get("segments") or []
    ]
    duration = body.get("duration")
    if duration is None:
        duration = segments[-1].end if segments else 0.0
    return Transcript(
        text=str(body.get("text", "")).strip(),
        language=str(body.get("language") or language),
        duration=float(duration),
        segments=segments,
    )
