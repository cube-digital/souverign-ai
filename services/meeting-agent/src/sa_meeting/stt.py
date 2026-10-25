"""Speech to text through audio-api (loopback only)."""

from __future__ import annotations

import io
import wave

import httpx

from .segmenter import RATE, Segment

_NOISE = {"", "[blank_audio]", "(silence)", "thank you.", "you", "."}


def is_noise(text: str) -> bool:
    return text.strip().lower() in _NOISE


def to_wav(pcm_bytes: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm_bytes)
    return buf.getvalue()


class SttClient:
    def __init__(
        self, audio_url: str, token: str, language: str, client: httpx.AsyncClient
    ) -> None:
        self._url = audio_url.rstrip("/") + "/v1/audio/transcriptions"
        self._token = token
        self._language = language
        self._client = client

    async def transcribe(self, seg: Segment) -> tuple[str, str]:
        r = await self._client.post(
            self._url,
            headers={"X-Internal-Token": self._token},
            files={"file": ("segment.wav", to_wav(seg.pcm.tobytes()), "audio/wav")},
            data={"language": self._language},
            timeout=60,
        )
        r.raise_for_status()
        body = r.json()
        return str(body.get("text", "")).strip(), str(body.get("language") or self._language)
