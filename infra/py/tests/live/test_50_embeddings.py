from __future__ import annotations

import numpy as np
import pytest

pytestmark = pytest.mark.live


def test_normalized_512_and_cross_language_ranking(cfg, embedder):
    emb = cfg["embeddings"]
    dim = emb["mrl_dim"]
    docs = [
        "The supplier shall deliver the goods no later than March 15.",
        "La livraison doit avoir lieu au plus tard le 15 mars.",
        "Mix the flour, sugar and eggs, then bake the cake for forty minutes.",
    ]
    q = embedder.encode(
        ["When is the delivery deadline?"], prompt=emb["query_prompt"], convert_to_numpy=True
    )
    d = embedder.encode(
        [emb["document_prompt"].format(title="none") + t for t in docs], convert_to_numpy=True
    )

    def trunc(x):
        x = np.asarray(x, dtype=np.float32)[:, :dim]
        return x / np.linalg.norm(x, axis=1, keepdims=True)

    q, d = trunc(q), trunc(d)
    assert d.shape == (3, dim)
    assert np.isfinite(d).all() and np.isfinite(q).all()
    assert np.allclose(np.linalg.norm(d, axis=1), 1, atol=1e-3)
    s = (d @ q[0]).tolist()
    assert min(s[0], s[1]) > s[2], s
