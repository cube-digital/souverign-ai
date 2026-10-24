from __future__ import annotations

import yaml
from sa_infra import hermes_profile as hp


def test_render_config_locks_down_toolsets_and_targets_local_llm():
    config = hp.render_config(
        llm_base_url="http://127.0.0.1:8000/v1",
        llm_model="some/model",
        api_port=8700,
        api_key="k",
        mcp_servers={"x": {"command": "c"}},
    )
    assert config["model"] == {
        "provider": "custom",
        "base_url": "http://127.0.0.1:8000/v1",
        "default": "some/model",
        "api_key": "local-no-key",
    }
    assert {"terminal", "file", "code_execution", "browser", "web"} <= set(
        config["agent"]["disabled_toolsets"]
    )
    assert config["gateway"]["api_server"] == {
        "enabled": True,
        "host": "127.0.0.1",
        "port": 8700,
        "key": "k",
    }
    assert config["mcp_servers"] == {"x": {"command": "c"}}
    assert "${" not in yaml.safe_dump(config)
