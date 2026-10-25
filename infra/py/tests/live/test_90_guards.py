from __future__ import annotations

import os

import psutil
import pytest
from sa_infra import egress, memguard, models_config, runfiles

pytestmark = pytest.mark.live
GIB = 1024**3
LISTEN_PORTS = (8000, 8081, 8700)  # vllm-mlx, whisper-server, Hermes smoke gateway


def _tree_listen_ports(pids):
    """Ports in LISTEN state owned by the given pids or their descendants.

    Uses per-process net_connections: the system-wide psutil.net_connections() needs root on macOS.
    """
    ports = set()
    for pid in pids:
        root = psutil.Process(pid)
        for p in [root, *root.children(recursive=True)]:
            ports.update(
                c.laddr.port
                for c in p.net_connections(kind="inet")
                if c.status == psutil.CONN_LISTEN
            )
    return ports


def test_loopback_only_and_memory_within_32_gib():
    services = runfiles.service_pids()
    assert {"llm", "whisper", "hermes-smoke"} <= services.keys(), services
    env = {**egress.read_env_file(models_config.REPO_ROOT / ".env"), **os.environ}
    allow = (
        egress.resolve_ips(egress.GOOGLE_OAUTH_HOSTS)
        if egress.google_oauth_enabled(env)
        else frozenset()
    )
    print(f"egress allowlist: {len(allow)} Google OAuth IPs")
    bad = egress.scan({*services.values(), os.getpid()}, allow=allow)
    for c in bad:
        print("egress:", c)
    assert bad == []
    owned = _tree_listen_ports(set(services.values()))
    for port in LISTEN_PORTS:
        assert port in owned, f":{port} is not listened on by the scanned services' process tree"
    ok, used = memguard.check()
    print(f"memory: used {used / GIB:.1f} GiB")
    assert ok, f"{used / GIB:.1f} GiB used"
