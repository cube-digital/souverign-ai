from __future__ import annotations

from pathlib import Path

from sa_audio.tts import KokoroEngine, PiperEngine, Router
from sa_infra import models_config


def test_router_picks_engine_by_language_with_english_fallback() -> None:
    router = Router(models_config.load(), models_dir=Path("/nonexistent"))
    assert isinstance(router.engine("de"), PiperEngine)
    assert isinstance(router.engine("ro"), PiperEngine)
    fr = router.engine("fr")
    assert isinstance(fr, KokoroEngine) and fr.lang_code == "f"
    assert router.engine("fr") is fr
    for other in ("pt", ""):
        eng = router.engine(other)
        assert isinstance(eng, KokoroEngine) and eng.lang_code == "a"
    assert router.engine("en", voice="am_adam").voice == "am_adam"  # type: ignore[attr-defined]
