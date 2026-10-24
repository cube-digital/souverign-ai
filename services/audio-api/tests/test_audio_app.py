from __future__ import annotations

import base64
import io
import json
from typing import Any

import httpx
import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient
from sa_audio.app import create_app

H = {"X-Internal-Token": "t"}


class FakeEngine:
    sample_rate = 8000

    def synth(self, text: str) -> np.ndarray:
        return np.full(len(text) * 10, 0.1, dtype=np.float32)


class FakeRouter:
    def engine(self, language: str | None, voice: str | None = None) -> FakeEngine:
        return FakeEngine()

    def voices(self) -> dict[str, Any]:
        return {}

    def allowed_voices(self) -> set[str]:
        return {"af_heart"}


def _app(handler: Any) -> TestClient:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return TestClient(create_app(FakeRouter(), "http://whisper", "t", client))  # type: ignore[arg-type]


def test_transcription_maps_whisper_reply_and_reports_outage() -> None:
    def ok(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/inference"
        return httpx.Response(
            200,
            json={
                "text": " Hello there. ",
                "language": "en",
                "duration": 1.5,
                "segments": [{"start": 0.0, "end": 1.5, "text": " Hello there. "}],
            },
        )

    files = {"file": ("a.wav", b"RIFF", "audio/wav")}
    resp = _app(ok).post("/v1/audio/transcriptions", files=files, headers=H)
    assert resp.status_code == 200
    assert resp.json() == {
        "text": "Hello there.",
        "language": "en",
        "duration": 1.5,
        "segments": [{"start": 0.0, "end": 1.5, "text": "Hello there."}],
    }

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    resp = _app(down).post("/v1/audio/transcriptions", files=files, headers=H)
    assert resp.status_code == 503
    assert resp.json() == {"error": "stt_unavailable"}


def test_streaming_speech_sends_one_ndjson_line_per_sentence_in_order() -> None:
    body = {"input": "First one. Second one! Third one?", "stream": True}
    resp = _app(lambda r: httpx.Response(200)).post("/v1/audio/speech", json=body, headers=H)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/x-ndjson")
    lines = [json.loads(line) for line in resp.text.splitlines()]
    assert [(x["seq"], x["text"]) for x in lines] == [
        (0, "First one."),
        (1, "Second one!"),
        (2, "Third one?"),
    ]
    data, rate = sf.read(io.BytesIO(base64.b64decode(lines[0]["wav_b64"])))
    assert rate == 8000 == lines[0]["sample_rate"] and len(data) == len("First one.") * 10


def test_speech_rejects_voice_outside_the_configured_set() -> None:
    app = _app(lambda r: httpx.Response(200))
    bad = app.post("/v1/audio/speech", json={"input": "Hi.", "voice": "../x"}, headers=H)
    assert bad.status_code == 422
    ok = app.post("/v1/audio/speech", json={"input": "Hi.", "voice": "af_heart"}, headers=H)
    assert ok.status_code == 200
