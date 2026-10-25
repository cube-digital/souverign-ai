"""Per-speaker speech segmentation: an energy gate for tests, Silero VAD live."""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import numpy as np

from .config import WorkerConfig

RATE = 16_000
SPEECH_RMS = 0.01  # fraction of full scale
START_MS = 100  # speech needed before a segment starts
_VAD: Any = None  # shared Silero model
_LOCK: asyncio.Lock | None = None


def _vad_lock() -> asyncio.Lock:
    global _LOCK
    if _LOCK is None:
        _LOCK = asyncio.Lock()
    return _LOCK


@dataclass
class Frame:
    ts_ms: int  # offset from the start of the track
    pcm: np.ndarray  # int16, 16 kHz mono


@dataclass
class Segment:
    t0_ms: int
    t1_ms: int
    pcm: np.ndarray  # int16, 16 kHz mono


def frame_ms(frame: Frame) -> int:
    return len(frame.pcm) * 1000 // RATE


def _is_speech(frame: Frame) -> bool:
    if len(frame.pcm) == 0:
        return False
    x = frame.pcm.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(x * x))) > SPEECH_RMS


def _build(frames: list[Frame]) -> Segment:
    return Segment(
        t0_ms=frames[0].ts_ms,
        t1_ms=frames[-1].ts_ms + frame_ms(frames[-1]),
        pcm=np.concatenate([f.pcm for f in frames]).astype(np.int16),
    )


class EnergySegmenter:
    def __init__(self, cfg: WorkerConfig) -> None:
        self.cfg = cfg

    async def segments(self, frames: AsyncIterator[Frame]) -> AsyncIterator[Segment]:
        cfg = self.cfg
        pre: deque[Frame] = deque()
        run: list[Frame] = []
        buf: list[Frame] = []
        active = False
        speech_ms = 0
        silence = 0

        def finish() -> Segment | None:
            seg = _build(buf) if speech_ms >= cfg.min_segment_ms else None
            return seg

        async for f in frames:
            ms = frame_ms(f)
            speech = _is_speech(f)
            if not active:
                if speech:
                    run.append(f)
                    if sum(frame_ms(r) for r in run) >= START_MS:
                        active, buf = True, [*pre, *run]
                        speech_ms, silence = sum(frame_ms(r) for r in run), 0
                        pre.clear()
                        run = []
                else:
                    pre.extend(run)
                    run = []
                    pre.append(f)
                    while sum(frame_ms(p) for p in pre) > cfg.preroll_ms:
                        pre.popleft()
                continue
            buf.append(f)
            if speech:
                speech_ms += ms
                silence = 0
            else:
                silence += ms
            total = sum(frame_ms(b) for b in buf)
            if silence >= cfg.silence_ms or total >= cfg.max_segment_ms:
                seg = finish()
                if seg:
                    yield seg
                buf, speech_ms = [], 0
                if silence >= cfg.silence_ms:
                    active, silence = False, 0
        if active and buf:
            seg = finish()
            if seg:
                yield seg


class SileroSegmenter:
    """Live segmenter: livekit-plugins-silero VAD end-of-speech events (needs the live extra)."""

    def __init__(self, cfg: WorkerConfig) -> None:
        self.cfg = cfg

    async def _load_vad(self) -> Any:
        """Load the model once per process, off the event loop, and share it across tracks."""
        global _VAD
        async with _vad_lock():
            if _VAD is None:
                from livekit.plugins import silero  # lazy: only the live extra has it

                _VAD = await asyncio.to_thread(
                    silero.VAD.load, min_silence_duration=0.5, min_speech_duration=0.1
                )
        return _VAD

    async def segments(self, frames: AsyncIterator[Frame]) -> AsyncIterator[Segment]:
        from livekit import rtc
        from livekit.agents import vad as lk_vad

        cfg = self.cfg
        stream = (await self._load_vad()).stream()
        end_ms = 0  # end of the newest frame pushed, offset from track start
        done = object()
        out: asyncio.Queue[object] = asyncio.Queue()

        async def pump() -> None:
            nonlocal end_ms
            try:
                async for f in frames:
                    end_ms = f.ts_ms + frame_ms(f)
                    stream.push_frame(
                        rtc.AudioFrame(
                            data=f.pcm.tobytes(),
                            sample_rate=RATE,
                            num_channels=1,
                            samples_per_channel=len(f.pcm),
                        )
                    )
            finally:
                stream.end_input()

        async def read() -> None:
            try:
                async for ev in stream:
                    if ev.type == lk_vad.VADEventType.END_OF_SPEECH:
                        await out.put(ev)
            finally:
                await out.put(done)

        tasks = [asyncio.create_task(pump()), asyncio.create_task(read())]
        try:
            while (ev := await out.get()) is not done:
                if ev.speech_duration * 1000 < cfg.min_segment_ms:  # type: ignore[attr-defined]
                    continue
                pcm = np.concatenate(
                    [np.frombuffer(fr.data, dtype=np.int16) for fr in ev.frames]  # type: ignore[attr-defined]
                )
                t0 = end_ms - len(pcm) * 1000 // RATE
                t1 = max(t0, end_ms - int(getattr(ev, "silence_duration", 0.0) * 1000))
                step = cfg.max_segment_ms * RATE // 1000
                for i in range(0, len(pcm), step):
                    chunk = pcm[i : i + step]
                    yield Segment(
                        t0_ms=t0 + i * 1000 // RATE,
                        t1_ms=min(t1, t0 + (i + len(chunk)) * 1000 // RATE)
                        if i + step >= len(pcm)
                        else t0 + (i + len(chunk)) * 1000 // RATE,
                        pcm=chunk,
                    )
        finally:
            for t in tasks:
                t.cancel()
