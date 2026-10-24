from __future__ import annotations

import psutil

LIMIT_BYTES = 32 * 1024**3


def used_bytes(vm=None) -> int:
    """System-wide used memory; RSS would miss MLX's Metal allocations."""
    vm = vm or psutil.virtual_memory()
    return vm.total - vm.available


def check(limit: int = LIMIT_BYTES, vm=None) -> tuple[bool, int]:
    used = used_bytes(vm)
    return used <= limit, used
