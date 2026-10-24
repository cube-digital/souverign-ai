from __future__ import annotations

import subprocess
import uuid

import httpx
import pytest
from sa_infra import hermes_profile
from sa_infra.models_config import REPO_ROOT

pytestmark = pytest.mark.live
BASE = "http://127.0.0.1:8700"
RUN = REPO_ROOT / ".run"


def headers(**extra):
    key = (RUN / "hermes-smoke.key").read_text().strip()
    return {"Authorization": f"Bearer {key}", **extra}


def test_hermes_answers_via_mcp_tool():
    subprocess.run([str(REPO_ROOT / "infra/hermes/pin.sh"), "--check"], check=True)
    log = RUN / "mcp-echo.log"
    before = log.read_text().count("\n") if log.exists() else 0
    r = httpx.post(
        f"{BASE}/v1/chat/completions",
        headers=headers(**{"X-Hermes-Session-Id": f"smoke-{uuid.uuid4()}"}),
        json={
            "model": "hermes",
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Use the add tool to compute 17 + 25 and reply with just the number."
                    ),
                }
            ],
        },
        timeout=300,
    )
    r.raise_for_status()
    assert "42" in r.json()["choices"][0]["message"]["content"]
    new = log.read_text().splitlines()[before:]
    assert any('"a": 17' in ln and '"b": 25' in ln for ln in new), new


def test_no_builtin_tool_exposed():
    r = httpx.get(f"{BASE}/v1/toolsets", headers=headers(), timeout=30)
    r.raise_for_status()
    toolsets = r.json()["data"]
    enabled = [t["name"] for t in toolsets if t["enabled"]]
    assert enabled == [], f"built-in toolsets exposed: {enabled}"
    # every toolset this Hermes version knows must be listed in toolsets.yaml
    missing = {t["name"] for t in toolsets} - set(hermes_profile.builtin_toolsets())
    assert not missing, f"add to infra/hermes/toolsets.yaml: {sorted(missing)}"
    cli = subprocess.run(
        ["hermes", "-p", "sa-smoke", "tools", "list", "--platform", "api_server"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "sa_echo" in cli and "enabled  " not in cli.replace("all tools enabled", "").replace(
        "✗ disabled", ""
    )
