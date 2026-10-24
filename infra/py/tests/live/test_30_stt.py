from __future__ import annotations

import time

import httpx
import pytest
from sa_infra.wer import wer

pytestmark = pytest.mark.live
URL = "http://127.0.0.1:8081/inference"


# whisper-server's verbose_json reports the language name ("english"), not the ISO code.
CODES = {"english": "en", "german": "de"}


def language(out):
    return CODES.get(out["language"], out["language"])


def transcribe(wav):
    t0 = time.perf_counter()
    with open(wav, "rb") as fh:
        r = httpx.post(
            URL,
            files={"file": (wav.name, fh, "audio/wav")},
            data={"response_format": "verbose_json", "temperature": "0"},
            timeout=120,
        )
    r.raise_for_status()
    print(f"stt: {time.perf_counter() - t0:.2f}s for {wav.name}")
    return r.json()


def test_english_wer_and_language(fixtures_dir, texts_dir):
    out = transcribe(fixtures_dir / "en_10s.wav")
    reference = (texts_dir / "en_10s.txt").read_text(encoding="utf-8")
    assert wer(reference, out["text"]) < 0.15, out["text"]
    assert language(out) == "en"


def test_german_detected(fixtures_dir):
    assert language(transcribe(fixtures_dir / "de.wav")) == "de"
