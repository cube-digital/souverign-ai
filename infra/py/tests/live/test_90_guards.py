from __future__ import annotations

import os

import pytest
from sa_infra import egress, memguard, runfiles

pytestmark = pytest.mark.live
GIB = 1024**3


def test_loopback_only_and_memory_within_32_gib():
    services = runfiles.service_pids()
    assert {"llm", "whisper", "hermes-smoke"} <= services.keys(), services
    bad = egress.scan({*services.values(), os.getpid()})
    for c in bad:
        print("egress:", c)
    assert bad == []
    ok, used = memguard.check()
    print(f"memory: used {used / GIB:.1f} GiB")
    assert ok, f"{used / GIB:.1f} GiB used"
