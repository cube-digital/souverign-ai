"""Embedding port, the real EmbeddingGemma adapter and a deterministic fake for tests."""

from __future__ import annotations

import hashlib
import threading
from typing import Literal, Protocol

import numpy as np

from sa_memory.config import EmbeddingConfig, load_embedding_config

Kind = Literal["query", "document"]
DIM = 512


class Embedder(Protocol):
    def embed(
        self, texts: list[str], kind: Kind, titles: list[str | None] | None = None
    ) -> np.ndarray:
        """Return shape (n, 512), float32, rows L2-normalized."""
        ...


def _normalize(m: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    return (m / np.maximum(norms, 1e-12)).astype(np.float32)


class HashEmbedder:
    """Deterministic fake: a vector seeded by the hash of the text."""

    loaded = True

    def embed(
        self, texts: list[str], kind: Kind, titles: list[str | None] | None = None
    ) -> np.ndarray:
        rows = []
        for t in texts:
            seed = int.from_bytes(hashlib.sha256(t.encode()).digest()[:8], "big")
            rows.append(np.random.default_rng(seed).standard_normal(DIM))
        if not rows:
            return np.zeros((0, DIM), dtype=np.float32)
        return _normalize(np.array(rows))


class EmbeddingGemma:
    """EmbeddingGemma via sentence-transformers, loaded lazily, truncated to mrl_dim."""

    def __init__(self, cfg: EmbeddingConfig | None = None) -> None:
        self._cfg = cfg or load_embedding_config()
        self._model = None
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def _load(self):
        if self._model is None:
            import torch
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(
                self._cfg.repo,
                device=self._cfg.device,
                model_kwargs={"torch_dtype": getattr(torch, self._cfg.dtype)},
                config_kwargs={"vision_config": None, "audio_config": None},
            )
        return self._model

    def embed(
        self, texts: list[str], kind: Kind, titles: list[str | None] | None = None
    ) -> np.ndarray:
        if not texts:
            return np.zeros((0, self._cfg.mrl_dim), dtype=np.float32)
        if kind == "query":
            inputs = [self._cfg.query_prompt + t for t in texts]
        else:
            ts = titles or [None] * len(texts)
            inputs = [
                self._cfg.document_prompt.format(title=title or "none") + t
                for t, title in zip(texts, ts, strict=True)
            ]
        with self._lock:
            model = self._load()
            # prompts are applied above, so no prompt_name is passed
            raw = model.encode(inputs, convert_to_numpy=True, normalize_embeddings=False)
        m = np.asarray(raw, dtype=np.float32)[:, : self._cfg.mrl_dim]
        return _normalize(m)
