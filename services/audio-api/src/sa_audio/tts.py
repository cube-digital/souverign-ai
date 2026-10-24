from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Protocol

import numpy as np
from sa_infra import models_config


class TtsEngine(Protocol):
    sample_rate: int

    def synth(self, text: str) -> np.ndarray:
        """Return float32 mono samples in [-1, 1]."""
        ...


_kokoro_lock = threading.Lock()
_kokoro_models: dict[str, Any] = {}


def _use_system_espeak() -> None:
    """misaki forces the espeakng-loader wheel, whose bundled library aborts on macOS arm64
    ("Wrong version of espeak-ng-data"). Prefer a system espeak-ng (Homebrew) when present;
    PHONEMIZER_ESPEAK_LIBRARY / PHONEMIZER_ESPEAK_DATA_PATH override the defaults."""
    lib = Path(os.environ.get("PHONEMIZER_ESPEAK_LIBRARY", "/opt/homebrew/lib/libespeak-ng.dylib"))
    data = Path(os.environ.get("PHONEMIZER_ESPEAK_DATA_PATH", "/opt/homebrew/share/espeak-ng-data"))
    if not (lib.is_file() and data.is_dir()):
        return
    import misaki.espeak  # noqa: F401  (sets the wheel paths on import; we override after)
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    EspeakWrapper.set_library(str(lib))
    EspeakWrapper.set_data_path(str(data))


def _kokoro_model(repo: str) -> Any:
    with _kokoro_lock:
        if repo not in _kokoro_models:
            _use_system_espeak()
            from mlx_audio.tts.utils import load_model

            _kokoro_models[repo] = load_model(repo)
        return _kokoro_models[repo]


class KokoroEngine:
    def __init__(self, lang_code: str, voice: str, repo: str, sample_rate: int = 24000) -> None:
        self.lang_code = lang_code
        self.voice = voice
        self.repo = repo
        self.sample_rate = sample_rate
        self._lock = threading.Lock()

    def synth(self, text: str) -> np.ndarray:
        model = _kokoro_model(self.repo)
        parts: list[np.ndarray] = []
        with self._lock:
            for result in model.generate(text=text, voice=self.voice, lang_code=self.lang_code):
                parts.append(np.asarray(result.audio, dtype=np.float32).reshape(-1))
        if not parts:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(parts)


class PiperEngine:
    def __init__(self, voice_path: Path) -> None:
        self.voice_path = Path(voice_path)
        self.sample_rate = 22050
        self._voice: Any = None
        self._lock = threading.Lock()

    def _load(self) -> Any:
        if self._voice is None:
            from piper import PiperVoice

            self._voice = PiperVoice.load(self.voice_path)
            self.sample_rate = int(self._voice.config.sample_rate)
        return self._voice

    def synth(self, text: str) -> np.ndarray:
        with self._lock:
            voice = self._load()
            parts = [
                np.asarray(c.audio_float_array, dtype=np.float32).reshape(-1)
                for c in voice.synthesize(text)
            ]
        if not parts:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(parts)


KOKORO_LANGS = ("en", "fr", "es", "it")
PIPER_LANGS = ("de", "ro")


class Router:
    """Maps a language code to a cached engine; unknown or empty falls back to English Kokoro."""

    def __init__(self, cfg: dict[str, Any], models_dir: Path | None = None) -> None:
        self.cfg = cfg
        self.models_dir = models_dir or models_config.models_dir(cfg)
        self._engines: dict[tuple[str, str | None], TtsEngine] = {}
        self._lock = threading.Lock()

    def resolve(self, language: str | None) -> str:
        lang = (language or "").strip().lower().split("-")[0].split("_")[0]
        return lang if lang in KOKORO_LANGS or lang in PIPER_LANGS else "en"

    def describe(self, language: str | None) -> dict[str, str]:
        lang = self.resolve(language)
        if lang in PIPER_LANGS:
            return {"engine": "piper", "voice": Path(self.cfg["tts"]["piper"]["voices"][lang]).name}
        return {"engine": "kokoro", "voice": self.cfg["tts"]["kokoro"]["languages"][lang]["voice"]}

    def engine(self, language: str | None, voice: str | None = None) -> TtsEngine:
        lang = self.resolve(language)
        key = (lang, voice if lang in KOKORO_LANGS else None)
        with self._lock:
            if key not in self._engines:
                self._engines[key] = self._build(lang, voice)
            return self._engines[key]

    def _build(self, lang: str, voice: str | None) -> TtsEngine:
        tts = self.cfg["tts"]
        if lang in PIPER_LANGS:
            rel = tts["piper"]["voices"][lang]
            return PiperEngine(self.models_dir / "piper" / f"{rel}.onnx")
        entry = tts["kokoro"]["languages"][lang]
        return KokoroEngine(
            entry["lang_code"],
            voice or entry["voice"],
            tts["kokoro"]["repo"],
            int(tts["kokoro"].get("sample_rate", 24000)),
        )

    def voices(self) -> dict[str, dict[str, str]]:
        return {lang: self.describe(lang) for lang in (*KOKORO_LANGS, *PIPER_LANGS)}
