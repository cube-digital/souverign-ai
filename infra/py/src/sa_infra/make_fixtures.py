"""Warm lazy TTS assets and render the STT fixtures. Run once by `make models`.

Network is allowed here: Kokoro's English G2P may fetch its spaCy model on first use.
The smoke run afterwards is offline. WAVs go to <models_dir>/fixtures/ as 16 kHz mono;
the reference texts live in infra/py/tests/live/fixtures/.
"""

from __future__ import annotations

import io
import wave
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from sa_infra import models_config as mc

TEXTS = Path(__file__).resolve().parents[2] / "tests" / "live" / "fixtures"
WARMUP = {"fr": "Bonjour à tous.", "es": "Hola a todos.", "it": "Ciao a tutti."}


def to_16k(audio: np.ndarray, sr: int) -> np.ndarray:
    n = round(len(audio) * 16000 / sr)
    x = np.linspace(0, len(audio) - 1, n)
    return np.interp(x, np.arange(len(audio)), audio).astype(np.float32)


def kokoro(model: Any, text: str, lang: str, cfg: dict[str, Any]) -> np.ndarray:
    spec = cfg["tts"]["kokoro"]["languages"][lang]
    results = model.generate(text=text, voice=spec["voice"], lang_code=spec["lang_code"])
    return np.concatenate([np.asarray(r.audio, dtype=np.float32) for r in results])


def piper(text: str, lang: str, cfg: dict[str, Any]) -> tuple[np.ndarray, int]:
    from piper import PiperVoice

    onnx = mc.models_dir(cfg) / "piper" / f"{cfg['tts']['piper']['voices'][lang]}.onnx"
    voice = PiperVoice.load(str(onnx))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize_wav(text, wf)
    buf.seek(0)
    audio, sr = sf.read(buf, dtype="float32")
    return audio, sr


def main() -> int:
    from mlx_audio.tts.utils import load_model

    cfg = mc.load()
    out = mc.models_dir(cfg) / "fixtures"
    out.mkdir(parents=True, exist_ok=True)
    model = load_model(cfg["tts"]["kokoro"]["repo"])
    kokoro_sr = cfg["tts"]["kokoro"]["sample_rate"]

    en_text = (TEXTS / "en_10s.txt").read_text(encoding="utf-8").strip()
    sf.write(out / "en_10s.wav", to_16k(kokoro(model, en_text, "en", cfg), kokoro_sr), 16000)
    for lang, text in WARMUP.items():
        kokoro(model, text, lang, cfg)  # caches phonemizer assets; audio discarded

    de_audio, de_sr = piper((TEXTS / "de.txt").read_text(encoding="utf-8").strip(), "de", cfg)
    sf.write(out / "de.wav", to_16k(de_audio, de_sr), 16000)
    piper("Bună ziua.", "ro", cfg)
    print(f"fixtures: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
