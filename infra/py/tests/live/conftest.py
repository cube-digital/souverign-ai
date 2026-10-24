from __future__ import annotations

from pathlib import Path

import pytest
from sa_infra import models_config

TEXTS = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="session")
def cfg():
    return models_config.load()


@pytest.fixture(scope="session")
def fixtures_dir(cfg):
    return models_config.models_dir(cfg) / "fixtures"


@pytest.fixture(scope="session")
def texts_dir():
    return TEXTS


@pytest.fixture(scope="session")
def kokoro_model(cfg):
    from mlx_audio.tts.utils import load_model
    from sa_infra.make_fixtures import use_system_espeak

    use_system_espeak()
    return load_model(cfg["tts"]["kokoro"]["repo"])


@pytest.fixture(scope="session")
def embedder(cfg):
    import torch
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(
        cfg["embeddings"]["repo"],
        device=cfg["embeddings"]["device"],
        model_kwargs={"torch_dtype": torch.bfloat16},
        config_kwargs={"vision_config": None, "audio_config": None},
    )
