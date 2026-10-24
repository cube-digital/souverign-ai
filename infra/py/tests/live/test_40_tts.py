from __future__ import annotations

import pytest

pytestmark = pytest.mark.live
TEXT = {
    "en": "Good morning, this is a short test of the local speech synthesis.",
    "fr": "Bonjour, ceci est un court test de la synthèse vocale locale.",
    "de": "Guten Morgen, dies ist ein kurzer Test der lokalen Sprachsynthese.",
}


@pytest.mark.parametrize("lang", ["en", "fr", "de"])
def test_tts_audio(lang, cfg, kokoro_model):
    import numpy as np
    from sa_infra import make_fixtures

    if lang == "de":
        audio, sr = make_fixtures.piper(TEXT[lang], "de", cfg)
    else:
        audio = make_fixtures.kokoro(kokoro_model, TEXT[lang], lang, cfg)
        sr = cfg["tts"]["kokoro"]["sample_rate"]
    assert np.isfinite(audio).all()
    assert len(audio) / sr > 1.0
    assert np.abs(audio).max() > 0.01
