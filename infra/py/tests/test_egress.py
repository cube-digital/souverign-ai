from __future__ import annotations

import os
import socket
import subprocess
import sys
import time

from sa_infra import egress
from sa_infra.egress import Conn


def test_offending_flags_only_non_loopback_remotes() -> None:
    ok = [
        Conn(1, "ESTABLISHED", "127.0.0.1", 80),
        Conn(1, "ESTABLISHED", "127.4.5.6", 80),
        Conn(1, "ESTABLISHED", "::1", 80),
        Conn(1, "ESTABLISHED", "::ffff:127.0.0.1", 80),
        Conn(1, "LISTEN", None, None),
    ]
    bad = [
        Conn(2, "ESTABLISHED", "fe80::1%lo0", 80),
        Conn(2, "ESTABLISHED", "192.168.1.10", 80),
        Conn(2, "ESTABLISHED", "140.82.112.3", 443),
        Conn(2, "NONE", "8.8.8.8", 53),
    ]
    assert egress.offending(ok + bad) == bad


def test_collect_includes_child_processes() -> None:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import socket,time;"
            f"s=socket.create_connection(('127.0.0.1',{port}));time.sleep(30)",
        ]
    )
    try:
        server.settimeout(10)
        accepted, _ = server.accept()
        time.sleep(0.2)
        conns = egress.collect([os.getpid()])
        assert any(c.pid == child.pid and c.remote_ip == "127.0.0.1" for c in conns)
        assert egress.scan([os.getpid()]) == []
        accepted.close()
    finally:
        child.terminate()
        child.wait(timeout=10)
        server.close()
