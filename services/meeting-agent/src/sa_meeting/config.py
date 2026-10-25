"""Worker configuration: plain settings from the environment, secrets only from stdin."""

from __future__ import annotations

import json
from collections.abc import Mapping

from pydantic import BaseModel


class WorkerConfig(BaseModel):
    bridge_url: str
    notetaker_id: str
    livekit_url: str
    audio_url: str
    stt_language: str = "en"
    lk_token: str
    meeting_token: str
    audio_token: str
    media_key: str | None = None
    poll_s: float = 2.0
    min_segment_ms: int = 600
    max_segment_ms: int = 20_000
    preroll_ms: int = 200
    silence_ms: int = 500


def _env(env: Mapping[str, str], name: str, default: str | None = None) -> str:
    value = env.get(f"SA_{name}") or env.get(name) or default
    if not value:
        raise ValueError(f"missing setting {name}")
    return value


def load(env: Mapping[str, str], stdin_line: str) -> WorkerConfig:
    """Settings come from `env`; the four secrets only from the JSON line on stdin."""
    secrets = json.loads(stdin_line)
    return WorkerConfig(
        bridge_url=_env(env, "BRIDGE_URL"),
        notetaker_id=_env(env, "NOTETAKER_ID"),
        livekit_url=_env(env, "LIVEKIT_URL", "ws://127.0.0.1:7880"),
        audio_url=_env(env, "AUDIO_URL", "http://127.0.0.1:8645"),
        stt_language=_env(env, "STT_LANGUAGE", "en"),
        lk_token=secrets["lk_token"],
        meeting_token=secrets["meeting_token"],
        audio_token=secrets["audio_token"],
        media_key=secrets.get("media_key"),
    )
