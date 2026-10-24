from __future__ import annotations

import subprocess

import pytest
from sa_infra.models_config import REPO_ROOT

pytestmark = pytest.mark.live


def test_pgvector_at_least_0_8():
    sql = (
        "CREATE EXTENSION IF NOT EXISTS vector; "
        "SELECT extversion FROM pg_extension WHERE extname='vector'"
    )
    out = subprocess.run(
        ["docker", "compose", "-f", "infra/docker-compose.yaml", "exec", "-T", "postgres"]
        + ["psql", "-U", "sa", "-d", "sa", "-tAc", sql],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()[-1]
    version = tuple(int(x) for x in out.split(".")[:2])
    assert version >= (0, 8), out
