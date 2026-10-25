"""The notetaker loop: consent-gated subscriptions, per-speaker VAD, sequential STT."""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import sys
import time
from collections.abc import AsyncIterator, Callable
from typing import Any

from .config import WorkerConfig
from .room import Room
from .segmenter import Frame, Segment
from .stt import SttClient, is_noise


def _log(event: str, **fields: Any) -> None:
    """Ids, counts and sizes only: never transcript text, audio, tokens or keys."""
    print(json.dumps({"event": event, **fields}), file=sys.stderr, flush=True)


async def _maybe(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _key_bytes(media_key: str | None) -> bytes | None:
    return base64.b64decode(media_key) if media_key else None


async def run(
    cfg: WorkerConfig,
    room: Room,
    make_segmenter: Callable[..., Any],
    stt: SttClient,
    bridge: Any,
    clock: Callable[[], float] = time.time,
) -> int:
    queue: asyncio.Queue[tuple[str, Segment]] = asyncio.Queue()
    allowed: set[str] = set()
    subscribed: set[str] = set()
    tasks: list[asyncio.Task[None]] = []
    n_posted = 0

    async def track(identity: str, frames: AsyncIterator[Frame]) -> None:
        base_ms = int(clock() * 1000)
        async for seg in make_segmenter(cfg).segments(frames):
            queue.put_nowait(
                (
                    identity,
                    Segment(base_ms + seg.t0_ms, base_ms + seg.t1_ms, seg.pcm),
                )
            )

    async def intake() -> None:
        async for identity, frames in room.tracks():
            if identity in allowed:
                tasks.append(asyncio.create_task(track(identity, frames)))

    async def transcribe_loop() -> None:
        nonlocal n_posted
        while True:
            identity, seg = await queue.get()
            if identity not in allowed:  # consent withdrawn since the audio was heard
                continue
            text, lang = await stt.transcribe(seg)
            if is_noise(text) or identity not in allowed:
                continue
            await _maybe(bridge.post_segment(identity, seg.t0_ms, seg.t1_ms, text, lang))
            n_posted += 1

    async def sync_subscriptions() -> None:
        present = await _maybe(room.participants())
        present = {p for p in present if p.startswith("user:")}
        subscribed.intersection_update(present)
        for identity in sorted(subscribed - allowed):
            await room.set_subscribed(identity, False)
            subscribed.discard(identity)
        for identity in sorted((allowed & present) - subscribed):
            await room.set_subscribed(identity, True)
            subscribed.add(identity)

    try:
        await room.connect(cfg.livekit_url, cfg.lk_token, _key_bytes(cfg.media_key))
        await _maybe(bridge.report("joined"))
        _log("joined", notetaker=cfg.notetaker_id)
        tasks.append(asyncio.create_task(intake()))
        tasks.append(asyncio.create_task(transcribe_loop()))
        while True:
            status, consented = await _maybe(bridge.state())
            if status != "active":
                break
            allowed.clear()
            allowed.update(consented)
            await sync_subscriptions()
            for t in tasks:
                if t.done() and t.exception():
                    raise t.exception()  # type: ignore[misc]
            await asyncio.sleep(cfg.poll_s)
        await room.disconnect()
        await _maybe(bridge.report("left"))
        _log("left", notetaker=cfg.notetaker_id, posted=n_posted)
        return 0
    except Exception as exc:
        _log("error", notetaker=cfg.notetaker_id, kind=type(exc).__name__)
        try:
            await room.disconnect()
            await _maybe(bridge.report("error", type(exc).__name__))
        except Exception:
            pass
        return 1
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
