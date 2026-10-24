from __future__ import annotations

import ipaddress
from collections.abc import Iterable
from dataclasses import dataclass

import psutil


@dataclass(frozen=True)
class Conn:
    pid: int
    status: str
    remote_ip: str | None
    remote_port: int | None


def is_loopback(ip: str) -> bool:
    addr = ipaddress.ip_address(ip.split("%", 1)[0])
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return addr.is_loopback


def offending(conns: Iterable[Conn]) -> list[Conn]:
    return [c for c in conns if c.remote_ip and not is_loopback(c.remote_ip)]


def collect(pids: Iterable[int], *, include_children: bool = True) -> list[Conn]:
    seen: set[int] = set()
    out: list[Conn] = []
    for pid in pids:
        try:
            proc = psutil.Process(pid)
            procs = [proc, *(proc.children(recursive=True) if include_children else [])]
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied as e:
            raise RuntimeError(f"cannot inspect pid {pid}") from e
        for p in procs:
            if p.pid in seen:
                continue
            seen.add(p.pid)
            try:
                raw = p.net_connections(kind="inet")
            except psutil.NoSuchProcess:
                continue
            except psutil.AccessDenied as e:
                raise RuntimeError(f"cannot inspect pid {p.pid}") from e
            for c in raw:
                raddr = c.raddr
                out.append(
                    Conn(
                        p.pid, c.status, raddr.ip if raddr else None, raddr.port if raddr else None
                    )
                )
    return out


def scan(pids: Iterable[int], *, include_children: bool = True) -> list[Conn]:
    return offending(collect(pids, include_children=include_children))
