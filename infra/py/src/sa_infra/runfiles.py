from __future__ import annotations

from pathlib import Path

import psutil

from sa_infra import models_config

RUN_DIR = models_config.REPO_ROOT / ".run"


def service_pids(run_dir: Path = RUN_DIR) -> dict[str, int]:
    """Map service name to pid for every live ``*.pid`` file in ``run_dir``."""
    if not run_dir.is_dir():
        return {}
    out: dict[str, int] = {}
    for f in sorted(run_dir.glob("*.pid")):
        try:
            pid = int(f.read_text().strip())
        except ValueError:
            continue
        if psutil.pid_exists(pid):
            out[f.stem] = pid
    return out
