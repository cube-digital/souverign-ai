"""Render Hermes profile homes from the templates in infra/hermes/.

`uv run python -m sa_infra.hermes_profile smoke` (called by `make up`) creates or refreshes
~/.hermes/profiles/sa-smoke: config on the local LLM, API server on 127.0.0.1:8700, every
built-in toolset disabled, one stdio MCP server (sa_echo). The bridge's HermesRuntime (SP2)
renders agent profiles from the same template.
"""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path
from string import Template
from typing import Any

import yaml

from sa_infra import models_config as mc

HERMES_DIR = mc.REPO_ROOT / "infra" / "hermes"
RUN_DIR = mc.REPO_ROOT / ".run"
SMOKE_PROFILE = "sa-smoke"
SMOKE_PORT = 8700


def builtin_toolsets() -> list[str]:
    data = yaml.safe_load((HERMES_DIR / "toolsets.yaml").read_text(encoding="utf-8"))
    return list(data["disable"])


def render_config(
    *,
    llm_base_url: str,
    llm_model: str,
    api_port: int,
    api_key: str,
    mcp_servers: dict[str, Any],
) -> dict[str, Any]:
    text = (HERMES_DIR / "config.template.yaml").read_text(encoding="utf-8")
    rendered = Template(text).substitute(
        LLM_BASE_URL=llm_base_url, LLM_MODEL=llm_model, API_PORT=api_port, API_KEY=api_key
    )
    config = yaml.safe_load(rendered)
    config["agent"]["disabled_toolsets"] = builtin_toolsets()
    config["mcp_servers"] = mcp_servers
    return config


def write_profile(home: Path, *, config: dict[str, Any], soul: str, env: dict[str, str]) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    (home / "SOUL.md").write_text(soul, encoding="utf-8")
    env_path = home / ".env"
    env_path.write_text("".join(f"{k}={v}\n" for k, v in env.items()), encoding="utf-8")
    env_path.chmod(0o600)


def smoke_key() -> str:
    RUN_DIR.mkdir(exist_ok=True)
    key_file = RUN_DIR / "hermes-smoke.key"
    key = os.environ.get("HERMES_SMOKE_API_KEY") or (
        key_file.read_text(encoding="utf-8").strip()
        if key_file.exists()
        else secrets.token_urlsafe(32)
    )
    key_file.write_text(key, encoding="utf-8")
    key_file.chmod(0o600)
    return key


def smoke() -> Path:
    cfg = mc.load()
    home = Path(os.environ.get("HERMES_PROFILES_DIR", "~/.hermes/profiles")).expanduser()
    home = home / SMOKE_PROFILE
    if not home.exists():
        subprocess.run(["hermes", "profile", "create", SMOKE_PROFILE], check=True)
    key = smoke_key()
    llm = cfg["llm"]
    config = render_config(
        llm_base_url=f"http://{llm['host']}:{llm['port']}/v1",
        llm_model=mc.get(cfg, f"llm.profiles.{mc.active_profile(cfg)}.repo"),
        api_port=SMOKE_PORT,
        api_key=key,
        mcp_servers={
            "sa_echo": {
                "command": shutil.which("uv") or "uv",
                "args": [
                    "run",
                    "--project",
                    str(mc.REPO_ROOT),
                    "python",
                    "-m",
                    "sa_infra.mcp_echo",
                ],
                "env": {"SA_ECHO_LOG": str(RUN_DIR / "mcp-echo.log")},
            }
        },
    )
    soul = Template((HERMES_DIR / "SOUL.template.md").read_text(encoding="utf-8")).substitute(
        AGENT_NAME="Smoke",
        OWNER_NAME="the smoke test",
        SOUL="Answer in one short sentence. Use a tool when asked to.",
    )
    write_profile(
        home,
        config=config,
        soul=soul,
        env={
            "API_SERVER_ENABLED": "true",
            "API_SERVER_HOST": "127.0.0.1",
            "API_SERVER_PORT": str(SMOKE_PORT),
            "API_SERVER_KEY": key,
        },
    )
    return home


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args != ["smoke"]:
        print("usage: python -m sa_infra.hermes_profile smoke", file=sys.stderr)
        return 2
    print(smoke())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
