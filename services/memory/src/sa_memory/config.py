"""Embedding settings from config/models.yaml (single source of truth)."""

from __future__ import annotations

from dataclasses import dataclass

from sa_infra import models_config


@dataclass(frozen=True)
class EmbeddingConfig:
    repo: str
    mrl_dim: int
    query_prompt: str
    document_prompt: str
    dtype: str
    device: str


def load_embedding_config() -> EmbeddingConfig:
    e = models_config.load()["embeddings"]
    return EmbeddingConfig(
        repo=e["repo"],
        mrl_dim=int(e["mrl_dim"]),
        query_prompt=e["query_prompt"],
        document_prompt=e["document_prompt"],
        dtype=e["dtype"],
        device=e["device"],
    )
