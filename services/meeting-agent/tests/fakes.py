"""Test doubles for the notetaker worker: FakeRoom, FakeBridge, STT over MockTransport."""

from __future__ import annotations

import asyncio
import io
import json
import time
import wave
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
import numpy as np
from sa_meeting.segmenter import Frame

FRAME_MS = 20
RATE = 16000
BASE_S = 1000.0  # fixed clock: epoch ms of track start = 1_000_000
BASE_MS = 1_000_000


async def wait_until(pred: Callable[[], bool], timeout: float = 4.0) -> None:
    end = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > end:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.002)


class _AwTuple(tuple):  # type: ignore[type-arg]
    """Result usable both directly and with await (the worker may do either)."""

    def __await__(self):  # type: ignore[no-untyped-def]
        async def _r() -> Any:
            return self

        return _r().__await__()


class _AwInt(int):
    def __await__(self):  # type: ignore[no-untyped-def]
        async def _r() -> Any:
            return self

        return _r().__await__()


class _AwNone:
    def __await__(self):  # type: ignore[no-untyped-def]
        async def _r() -> None:
            return None

        return _r().__await__()


class Track:
    """Builds 20 ms frames on a per-speaker timeline (ts_ms is the offset from track start)."""

    def __init__(self) -> None:
        self.cursor = 0

    def silence(self, ms: int) -> list[Frame]:
        return self._frames(ms, 0.0)

    def tone(self, ms: int, amp: float, freq: float = 440.0) -> list[Frame]:
        return self._frames(ms, amp, freq)

    def _frames(self, ms: int, amp: float, freq: float = 440.0) -> list[Frame]:
        out = []
        n = RATE * FRAME_MS // 1000
        for _ in range(ms // FRAME_MS):
            t = (np.arange(n) + self.cursor * RATE // 1000) / RATE
            pcm = (amp * 32767 * np.sin(2 * np.pi * freq * t)).astype(np.int16)
            out.append(Frame(ts_ms=self.cursor, pcm=pcm))
            self.cursor += FRAME_MS
        return out


class FakeRoom:
    def __init__(self, identities: set[str]) -> None:
        self._identities = set(identities)
        self.connect_args: dict[str, Any] | None = None
        self.subscribe_calls: list[tuple[str, bool]] = []
        self.disconnected = False
        self._queues: dict[str, asyncio.Queue[Frame | None]] = {}
        self._new: asyncio.Queue[tuple[str, AsyncIterator[Frame]] | None] = asyncio.Queue()

    async def connect(self, url: str, token: str, e2ee_key: bytes | None) -> None:
        self.connect_args = {"url": url, "token": token, "e2ee_key": e2ee_key}

    def participants(self) -> set[str]:
        return set(self._identities)

    async def set_subscribed(self, identity: str, on: bool) -> None:
        self.subscribe_calls.append((identity, on))
        if on and identity not in self._queues:
            q: asyncio.Queue[Frame | None] = asyncio.Queue()
            self._queues[identity] = q
            self._new.put_nowait((identity, self._drain(q)))
        elif not on and identity in self._queues:
            self._queues.pop(identity).put_nowait(None)

    async def _drain(self, q: asyncio.Queue[Frame | None]) -> AsyncIterator[Frame]:
        while (f := await q.get()) is not None:
            yield f

    async def tracks(self) -> AsyncIterator[tuple[str, AsyncIterator[Frame]]]:
        while (item := await self._new.get()) is not None:
            yield item

    async def disconnect(self) -> None:
        self.disconnected = True
        for q in self._queues.values():
            q.put_nowait(None)
        self._new.put_nowait(None)

    # test driver API
    def subscribed(self, identity: str) -> bool:
        return identity in self._queues

    def feed(self, identity: str, frames: list[Frame]) -> None:
        """Audio is only delivered to a subscribed track; otherwise it is lost."""
        q = self._queues.get(identity)
        if q is not None:
            for f in frames:
                q.put_nowait(f)

    def subscribed_true(self) -> set[str]:
        return {i for i, on in self.subscribe_calls if on}


class FakeBridge:
    def __init__(self, allowed: Callable[[FakeBridge], set[str]] | set[str]) -> None:
        self._allowed = allowed
        self.status = "active"
        self.state_calls = 0
        self.posts: list[tuple[str, int, int, str, str]] = []
        self.reports: list[tuple[str, str | None]] = []
        self.gate = False
        self.stop_after_polls: int | None = None

    def state(self) -> Any:
        self.state_calls += 1
        if self.stop_after_polls is not None and self.state_calls > self.stop_after_polls:
            self.status = "stopped"
        a = self._allowed(self) if callable(self._allowed) else self._allowed
        return _AwTuple((self.status, set(a)))

    def post_segment(self, speaker: str, t0_ms: int, t1_ms: int, text: str, lang: str) -> Any:
        self.posts.append((speaker, t0_ms, t1_ms, text, lang))
        return _AwInt(200)

    def report(self, state: str, detail: str | None = None) -> Any:
        self.reports.append((state, detail))
        return _AwNone()


class SttRecorder:
    """httpx.MockTransport STT: reply text is keyed by the loudest sample (rounded to 0.1)."""

    def __init__(self, texts: dict[float, str]) -> None:
        self.texts = texts
        self.amps: list[float] = []
        self.headers: list[str | None] = []
        self.paths: list[str] = []
        self.wav_params: list[tuple[int, int]] = []
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(self._handle))

    def _handle(self, request: httpx.Request) -> httpx.Response:
        body = request.content
        wav = wave.open(io.BytesIO(body[body.index(b"RIFF") :]))
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
        amp = round(float(np.abs(pcm).max()) / 32767, 1)
        self.amps.append(amp)
        self.headers.append(request.headers.get("x-internal-token"))
        self.paths.append(request.url.path)
        self.wav_params.append((wav.getframerate(), wav.getnchannels()))
        return httpx.Response(
            200,
            content=json.dumps({"text": self.texts[amp], "language": "en"}),
            headers={"content-type": "application/json"},
        )
