from __future__ import annotations

import socket
from pathlib import Path

from sa_infra import egress
from sa_infra.egress import Conn

FULL = {
    "GOOGLE_CLIENT_ID": "id.apps.example.com",
    "GOOGLE_CLIENT_SECRET": "s3cret",
    "PUBLIC_BASE_URL": "https://sa.example.com",
    "AUTH_ALLOWED_EMAILS": "a@example.com",
}


def _info(ip: str) -> tuple:
    return (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))


def test_google_off_allows_nothing_and_google_ip_is_flagged() -> None:
    no_base = {k: v for k, v in FULL.items() if k != "PUBLIC_BASE_URL"}
    no_list = {k: v for k, v in FULL.items() if k != "AUTH_ALLOWED_EMAILS"}
    blank_secret = {**FULL, "GOOGLE_CLIENT_SECRET": "   "}
    assert egress.google_oauth_enabled({}) is False
    assert (
        egress.google_oauth_enabled({"GOOGLE_CLIENT_ID": "x", "GOOGLE_CLIENT_SECRET": "y"}) is False
    )
    assert egress.google_oauth_enabled(no_base) is False
    assert egress.google_oauth_enabled(no_list) is False
    assert egress.google_oauth_enabled(blank_secret) is False
    google = Conn(7, "ESTABLISHED", "142.250.1.1", 443)
    assert egress.offending([google]) == [google]
    assert egress.offending([google], frozenset()) == [google]


def test_google_on_allows_only_the_three_hosts_on_443() -> None:
    assert egress.GOOGLE_OAUTH_HOSTS == (
        "accounts.google.com",
        "oauth2.googleapis.com",
        "www.googleapis.com",
    )
    assert egress.google_oauth_enabled(FULL) is True
    asked: list[tuple[str, int]] = []
    table = {
        "accounts.google.com": "142.250.1.1",
        "oauth2.googleapis.com": "142.250.1.2",
        "www.googleapis.com": "fe80::9%lo0",
    }

    def fake(host: str, port: int, **_: object) -> list:
        asked.append((host, port))
        return [_info(table[host])]

    allow = egress.resolve_ips(egress.GOOGLE_OAUTH_HOSTS, resolver=fake)
    assert asked == [(h, 443) for h in egress.GOOGLE_OAUTH_HOSTS]
    assert allow == frozenset({"142.250.1.1", "142.250.1.2", "fe80::9"})

    ok = Conn(1, "ESTABLISHED", "142.250.1.1", 443)
    ok6 = Conn(1, "ESTABLISHED", "fe80::9%lo0", 443)
    wrong_port = Conn(2, "ESTABLISHED", "142.250.1.1", 80)
    other_ip = Conn(2, "ESTABLISHED", "8.8.8.8", 443)
    local = Conn(3, "ESTABLISHED", "127.0.0.1", 5432)
    assert egress.offending([ok, ok6, wrong_port, other_ip, local], allow) == [wrong_port, other_ip]

    def boom(host: str, port: int, **_: object) -> list:
        raise OSError("no dns")

    assert egress.resolve_ips(["a.example"], resolver=boom) == frozenset()


def test_guard_env_comes_from_dotenv_and_environment(tmp_path: Path) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "# demo\n"
        "\n"
        'GOOGLE_CLIENT_ID="id.apps.example.com"\n'
        "GOOGLE_CLIENT_SECRET='s3cret'  # trailing\n"
        "PUBLIC_BASE_URL=https://sa.example.com\n"
    )
    parsed = egress.read_env_file(dotenv)
    assert parsed == {
        "GOOGLE_CLIENT_ID": "id.apps.example.com",
        "GOOGLE_CLIENT_SECRET": "s3cret",
        "PUBLIC_BASE_URL": "https://sa.example.com",
    }
    assert egress.read_env_file(tmp_path / "missing.env") == {}
    assert egress.google_oauth_enabled(parsed) is False
    merged = {**parsed, "AUTH_ALLOWED_DOMAINS": "example.com"}
    assert egress.google_oauth_enabled(merged) is True
