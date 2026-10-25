from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

from sa_meeting.config import WorkerConfig, load
from sa_meeting.segmenter import EnergySegmenter
from sa_meeting.stt import SttClient
from sa_meeting.worker import run


def _fakes() -> Any:
    spec = importlib.util.spec_from_file_location(
        "sa_meeting_test_fakes", Path(__file__).with_name("fakes.py")
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


F = _fakes()
ANA, VLAD, RARES = "user:ana", "user:vlad", "user:rares"


def _cfg(**kw: Any) -> WorkerConfig:
    base: dict[str, Any] = dict(
        bridge_url="http://127.0.0.1:1",
        notetaker_id="agent:notes",
        livekit_url="ws://127.0.0.1:7880",
        audio_url="http://127.0.0.1:8645",
        lk_token="lk-secret",
        meeting_token="mt-secret",
        audio_token="audio-secret",
        media_key=None,
        poll_s=0.05,
    )
    return WorkerConfig(**{**base, **kw})


def _start(cfg: WorkerConfig, room: Any, bridge: Any, stt: Any) -> asyncio.Task[int]:
    client = SttClient(cfg.audio_url, cfg.audio_token, cfg.stt_language, client=stt.client)
    return asyncio.create_task(
        run(cfg, room, lambda *a, **k: EnergySegmenter(cfg), client, bridge, clock=lambda: F.BASE_S)
    )


async def _finish(task: asyncio.Task[int], bridge: Any) -> int:
    bridge.status = "stopped"
    return await asyncio.wait_for(task, 5)


def test_two_speakers_attributed_in_time_order_one_stt_call_per_segment() -> None:
    async def scenario() -> None:
        cfg = _cfg()
        room = F.FakeRoom({ANA, VLAD})
        bridge = F.FakeBridge({ANA, VLAD})
        stt = F.SttRecorder({0.3: "ana speaks", 0.6: "vlad speaks"})
        task = _start(cfg, room, bridge, stt)
        await F.wait_until(lambda: room.subscribed(ANA) and room.subscribed(VLAD))
        ana, vlad = F.Track(), F.Track()
        room.feed(ANA, ana.silence(500) + ana.tone(1000, 0.3) + ana.silence(1000))
        await F.wait_until(lambda: len(bridge.posts) == 1)
        room.feed(VLAD, vlad.silence(3000) + vlad.tone(1000, 0.6) + vlad.silence(1000))
        await F.wait_until(lambda: len(bridge.posts) == 2)
        room.feed(ANA, ana.silence(2500) + ana.tone(800, 0.3) + ana.silence(1000))
        await F.wait_until(lambda: len(bridge.posts) == 3)
        assert await _finish(task, bridge) == 0

        assert [(p[0], p[3]) for p in bridge.posts] == [
            (ANA, "ana speaks"),
            (VLAD, "vlad speaks"),
            (ANA, "ana speaks"),
        ]
        for post, onset in zip(bridge.posts, (500, 3000, 5000), strict=True):
            assert abs(post[1] - (F.BASE_MS + onset - 200)) <= 40  # epoch ms, with pre-roll
            assert post[2] > post[1]
        assert len(stt.amps) == 3  # exactly one transcription per segment
        assert stt.paths == ["/v1/audio/transcriptions"] * 3
        assert stt.headers == ["audio-secret"] * 3
        assert stt.wav_params == [(16000, 1)] * 3

    asyncio.run(scenario())


def test_participant_who_has_not_consented_is_never_subscribed_or_transcribed() -> None:
    async def scenario() -> None:
        room = F.FakeRoom({ANA, RARES})
        bridge = F.FakeBridge({ANA})
        stt = F.SttRecorder({0.3: "ana speaks", 0.9: "rares speaks"})
        task = _start(_cfg(), room, bridge, stt)
        await F.wait_until(lambda: room.subscribed(ANA))
        ana, rares = F.Track(), F.Track()
        room.feed(RARES, rares.tone(1500, 0.9) + rares.silence(1000))
        room.feed(ANA, ana.tone(1000, 0.3) + ana.silence(1000))
        await F.wait_until(lambda: len(bridge.posts) == 1)
        await asyncio.sleep(0.2)  # let any stray work surface
        assert await _finish(task, bridge) == 0

        assert room.subscribed_true() == {ANA}
        assert (RARES, True) not in room.subscribe_calls
        assert stt.amps == [0.3]
        assert [(p[0], p[3]) for p in bridge.posts] == [(ANA, "ana speaks")]

    asyncio.run(scenario())


def test_consent_given_later_takes_effect_at_next_poll_not_retroactively() -> None:
    async def scenario() -> None:
        room = F.FakeRoom({ANA, VLAD})
        bridge = F.FakeBridge(lambda b: {ANA, VLAD} if b.gate else {ANA})
        stt = F.SttRecorder({0.3: "ana speaks", 0.6: "vlad early", 0.7: "vlad later"})
        task = _start(_cfg(), room, bridge, stt)
        await F.wait_until(lambda: room.subscribed(ANA))
        assert not room.subscribed(VLAD)
        ana, vlad = F.Track(), F.Track()
        room.feed(VLAD, vlad.tone(1000, 0.6) + vlad.silence(1000))  # before consent: lost
        room.feed(ANA, ana.tone(1000, 0.3) + ana.silence(1000))
        await F.wait_until(lambda: len(bridge.posts) == 1)
        bridge.gate = True  # vlad accepts; picked up at the next poll
        await F.wait_until(lambda: room.subscribed(VLAD))
        room.feed(VLAD, vlad.tone(1000, 0.7) + vlad.silence(1000))
        await F.wait_until(lambda: len(bridge.posts) == 2)
        assert await _finish(task, bridge) == 0

        assert [(p[0], p[3]) for p in bridge.posts] == [(ANA, "ana speaks"), (VLAD, "vlad later")]
        assert stt.amps == [0.3, 0.7]

    asyncio.run(scenario())


def test_worker_leaves_when_notes_stop() -> None:
    async def scenario() -> tuple[int, Any, Any]:
        room = F.FakeRoom({ANA})
        bridge = F.FakeBridge({ANA})
        bridge.stop_after_polls = 1
        stt = F.SttRecorder({})
        rc = await asyncio.wait_for(_start(_cfg(), room, bridge, stt), 5)
        return rc, room, bridge

    rc, room, bridge = asyncio.run(scenario())
    assert rc == 0
    assert room.disconnected is True
    assert [r[0] for r in bridge.reports] == ["joined", "left"]
    assert room.connect_args["url"] == "ws://127.0.0.1:7880"
    assert room.connect_args["token"] == "lk-secret"


def test_noise_transcripts_are_not_posted() -> None:
    async def scenario() -> None:
        room = F.FakeRoom({ANA})
        bridge = F.FakeBridge({ANA})
        stt = F.SttRecorder({0.3: " thank YOU. ", 0.4: "[blank_audio]", 0.5: "Budget approved"})
        task = _start(_cfg(), room, bridge, stt)
        await F.wait_until(lambda: room.subscribed(ANA))
        ana = F.Track()
        room.feed(ANA, ana.tone(1000, 0.3) + ana.silence(1000))
        room.feed(ANA, ana.tone(1000, 0.4) + ana.silence(1000))
        room.feed(ANA, ana.tone(1000, 0.5) + ana.silence(1000))
        await F.wait_until(lambda: len(stt.amps) == 3)
        await F.wait_until(lambda: len(bridge.posts) == 1)
        assert await _finish(task, bridge) == 0
        assert [(p[0], p[3]) for p in bridge.posts] == [(ANA, "Budget approved")]

    asyncio.run(scenario())


def test_media_key_comes_only_from_stdin_and_reaches_the_room() -> None:
    raw = bytes(range(32))
    key = base64.b64encode(raw).decode()
    env = {
        "BRIDGE_URL": "http://127.0.0.1:8647",
        "NOTETAKER_ID": "agent:notes",
        "LIVEKIT_URL": "ws://127.0.0.1:7880",
        "AUDIO_URL": "http://127.0.0.1:8645",
        "LK_TOKEN": "decoy-from-env",
    }
    line = json.dumps(
        {"lk_token": "lk-secret", "meeting_token": "mt", "audio_token": "at", "media_key": key}
    )
    cfg = load(env, line)
    assert "media_key" not in {k.lower() for k in env} and "MEDIA_KEY" not in env
    assert cfg.media_key == key
    assert cfg.lk_token == "lk-secret"

    async def scenario() -> Any:
        room = F.FakeRoom(set())
        bridge = F.FakeBridge(set())
        bridge.stop_after_polls = 0
        await asyncio.wait_for(_start(cfg, room, bridge, F.SttRecorder({})), 5)
        return room

    room = asyncio.run(scenario())
    assert room.connect_args["e2ee_key"] in (raw, key.encode())
