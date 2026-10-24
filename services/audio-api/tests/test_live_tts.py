from __future__ import annotations

import numpy as np
import pytest
from sa_audio.tts import Router
from sa_infra import models_config

pytestmark = pytest.mark.live


@pytest.mark.parametrize(
    ("lang", "text"),
    [
        ("en", "Good morning. This is a short test of the English voice."),
        ("de", "Guten Morgen. Dies ist ein kurzer Test der deutschen Stimme."),
    ],
)
def test_real_engines_speak_english_and_german_offline(
    lang: str, text: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    engine = Router(models_config.load()).engine(lang)
    audio = engine.synth(text)
    assert audio.dtype == np.float32
    assert np.isfinite(audio).all()
    assert len(audio) / engine.sample_rate > 1.0
