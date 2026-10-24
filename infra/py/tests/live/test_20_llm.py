from __future__ import annotations

import json
import time

import httpx
import pytest
from sa_infra import models_config as mc

pytestmark = pytest.mark.live

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add",
            "description": "Add two integers.",
            "parameters": {
                "type": "object",
                "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                "required": ["a", "b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_notes",
            "description": "Search the user's notes.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
]


def chat(cfg, prompt, tools=None):
    llm = cfg["llm"]
    profile = mc.active_profile(cfg)
    body = {
        "model": llm["profiles"][profile]["repo"],
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 512,
    }
    if tools:
        body["tools"] = tools
    if profile == "fast":
        body["chat_template_kwargs"] = {"enable_thinking": False}
    t0 = time.perf_counter()
    r = httpx.post(
        f"http://{llm['host']}:{llm['port']}/v1/chat/completions", json=body, timeout=120
    )
    r.raise_for_status()
    print(f"llm: {time.perf_counter() - t0:.2f}s for {prompt!r}")
    return r.json()["choices"][0]["message"]


def test_picks_add_with_int_arguments(cfg):
    msg = chat(cfg, "What is 1234 plus 4321? Use a tool.", TOOLS)
    call = msg["tool_calls"][0]["function"]
    args = json.loads(call["arguments"])
    assert call["name"] == "add"
    assert (args["a"], args["b"]) == (1234, 4321) or (args["a"], args["b"]) == (4321, 1234)
    assert isinstance(args["a"], int) and isinstance(args["b"], int)


def test_picks_weather_for_geneva(cfg):
    msg = chat(cfg, "What's the weather in Geneva right now?", TOOLS)
    call = msg["tool_calls"][0]["function"]
    assert call["name"] == "get_weather"
    assert "Geneva" in json.loads(call["arguments"])["city"]


def test_plain_reply_has_no_think(cfg):
    msg = chat(cfg, "Reply with the single word OK.")
    assert "OK" in msg["content"]
    assert "<think>" not in msg["content"]
