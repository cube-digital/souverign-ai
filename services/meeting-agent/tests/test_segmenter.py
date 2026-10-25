from __future__ import annotations

import asyncio

import numpy as np
from sa_meeting.config import WorkerConfig
from sa_meeting.segmenter import EnergySegmenter, Frame

RATE = 16000


def _cfg() -> WorkerConfig:
    return WorkerConfig(
        bridge_url="http://127.0.0.1:1",
        notetaker_id="agent:notes",
        livekit_url="ws://127.0.0.1:1",
        audio_url="http://127.0.0.1:1",
        lk_token="a",
        meeting_token="b",
        audio_token="c",
        media_key=None,
    )


def _frames(plan: list[tuple[int, float]]) -> list[Frame]:
    """plan: (duration_ms, amplitude as a fraction of full scale); 20 ms frames."""
    out: list[Frame] = []
    ts = 0
    for ms, amp in plan:
        for _ in range(ms // 20):
            t = (np.arange(320) + ts * 16) / RATE
            pcm = (amp * 32767 * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
            out.append(Frame(ts_ms=ts, pcm=pcm))
            ts += 20
    return out


def _segments(frames: list[Frame]) -> list:
    async def src():
        for f in frames:
            yield f

    async def collect():
        return [s async for s in EnergySegmenter(_cfg()).segments(src())]

    return asyncio.run(collect())


def test_short_burst_dropped_and_preroll_included() -> None:
    # speech onset at 1000 ms; 0.4 s burst later must be dropped (< 600 ms)
    segs = _segments(_frames([(1000, 0.0), (1000, 0.3), (1000, 0.0), (400, 0.3), (1000, 0.0)]))
    assert len(segs) == 1
    s = segs[0]
    assert abs(s.t0_ms - 800) <= 20  # 200 ms pre-roll before the onset
    assert 1000 + 200 <= s.t1_ms - s.t0_ms <= 1800
    assert s.pcm.dtype == np.int16
    assert len(s.pcm) == (s.t1_ms - s.t0_ms) * 16
    assert not s.pcm[:2800].any()  # the pre-roll is the silence before the onset
    assert np.abs(s.pcm[3700:4000]).max() > 0.2 * 32767  # then speech


def test_continuous_speech_is_cut_at_20_seconds() -> None:
    segs = _segments(_frames([(25_000, 0.3), (1000, 0.0)]))
    assert len(segs) == 2
    assert abs((segs[0].t1_ms - segs[0].t0_ms) - 20_000) <= 20
    assert abs(segs[1].t0_ms - segs[0].t1_ms) <= 20
    assert 4_800 <= segs[1].t1_ms - segs[1].t0_ms <= 5_700
