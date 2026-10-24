from __future__ import annotations

from types import SimpleNamespace

from sa_infra import memguard

GIB = 1024**3


def test_limit_is_inclusive() -> None:
    at_limit = SimpleNamespace(total=36 * GIB, available=4 * GIB)
    assert memguard.check(vm=at_limit) == (True, 32 * GIB)
    over = SimpleNamespace(total=36 * GIB, available=4 * GIB - 1)
    assert memguard.check(vm=over) == (False, 32 * GIB + 1)
