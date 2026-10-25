from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

import psutil

GOOGLE_OAUTH_HOSTS = ("accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com")


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


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=VALUE lines of a .env file; comments and blank lines ignored."""
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip("\"'")
    return out


def google_oauth_enabled(env: Mapping[str, str]) -> bool:
    """Mirrors services/bridge/src/oidc/config.ts: id, secret, base URL and an allowlist."""

    def has(k: str) -> bool:
        return bool(env.get(k, "").strip())

    return (
        has("GOOGLE_CLIENT_ID")
        and has("GOOGLE_CLIENT_SECRET")
        and has("PUBLIC_BASE_URL")
        and (has("AUTH_ALLOWED_EMAILS") or has("AUTH_ALLOWED_DOMAINS"))
    )


def resolve_ips(
    hosts: Iterable[str], resolver: Callable[..., list] = socket.getaddrinfo
) -> frozenset[str]:
    ips: set[str] = set()
    for host in hosts:
        try:
            infos = resolver(host, 443, proto=socket.IPPROTO_TCP)
        except OSError:
            continue
        ips.update(str(info[4][0]).split("%", 1)[0] for info in infos)
    return frozenset(ips)


def offending(conns: Iterable[Conn], allow: frozenset[str] = frozenset()) -> list[Conn]:
    return [
        c
        for c in conns
        if c.remote_ip
        and not is_loopback(c.remote_ip)
        and not (c.remote_port == 443 and c.remote_ip.split("%", 1)[0] in allow)
    ]


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


def scan(
    pids: Iterable[int], *, include_children: bool = True, allow: frozenset[str] = frozenset()
) -> list[Conn]:
    return offending(collect(pids, include_children=include_children), allow)
