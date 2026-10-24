from __future__ import annotations

from sa_infra import models_config as mc


def test_llm_lookup_follows_profile_override(monkeypatch, capsys):
    cfg = mc.load()
    monkeypatch.setenv("LLM_PROFILE", "quality")
    assert mc.main(["llm", "repo"]) == 0
    assert capsys.readouterr().out.strip() == cfg["llm"]["profiles"]["quality"]["repo"]
    monkeypatch.setenv("LLM_PROFILE", "nope")
    assert mc.main(["llm", "repo"]) == 1
