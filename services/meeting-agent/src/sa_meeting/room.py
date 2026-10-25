"""The SFU seen by the worker: a Protocol, plus the LiveKit implementation (live extra)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any, Protocol

import numpy as np

from .segmenter import RATE, Frame


class Room(Protocol):
    async def connect(self, url: str, token: str, e2ee_key: bytes | None) -> None: ...

    def participants(self) -> set[str]: ...

    async def set_subscribed(self, identity: str, on: bool) -> None: ...

    def tracks(self) -> AsyncIterator[tuple[str, AsyncIterator[Frame]]]: ...

    async def disconnect(self) -> None: ...


class LiveKitRoom:
    """Nothing is subscribed unless set_subscribed(identity, True) was called for it."""

    def __init__(self) -> None:
        from livekit import rtc  # lazy: only the live extra has it

        self._rtc = rtc
        self._room = rtc.Room()
        self._wanted: set[str] = set()
        self._streams: dict[str, Any] = {}
        self._new: asyncio.Queue[tuple[str, AsyncIterator[Frame]] | None] = asyncio.Queue()

    async def connect(self, url: str, token: str, e2ee_key: bytes | None) -> None:
        rtc = self._rtc
        encryption = None
        if e2ee_key:
            encryption = rtc.E2EEOptions(
                key_provider_options=rtc.KeyProviderOptions(shared_key=e2ee_key)
            )
        options = rtc.RoomOptions(auto_subscribe=False, encryption=encryption)
        self._room.on("track_published", self._on_published)
        self._room.on("track_subscribed", self._on_subscribed)
        self._room.on("track_unsubscribed", self._on_unsubscribed)
        await self._room.connect(url, token, options=options)

    def participants(self) -> set[str]:
        return {p.identity for p in self._room.remote_participants.values()}

    def _audio_pubs(self, identity: str) -> list[Any]:
        kind = self._rtc.TrackKind.KIND_AUDIO
        return [
            pub
            for p in self._room.remote_participants.values()
            if p.identity == identity
            for pub in p.track_publications.values()
            if pub.kind == kind
        ]

    async def set_subscribed(self, identity: str, on: bool) -> None:
        if not identity.startswith("user:"):
            return
        (self._wanted.add if on else self._wanted.discard)(identity)
        for pub in self._audio_pubs(identity):
            pub.set_subscribed(on)

    def _on_published(self, publication: Any, participant: Any) -> None:
        if (
            participant.identity in self._wanted
            and publication.kind == self._rtc.TrackKind.KIND_AUDIO
        ):
            publication.set_subscribed(True)

    def _on_subscribed(self, track: Any, publication: Any, participant: Any) -> None:
        if participant.identity not in self._wanted:
            publication.set_subscribed(False)
            return
        stream = self._rtc.AudioStream(track, sample_rate=RATE, num_channels=1)
        self._streams[participant.identity] = stream
        self._new.put_nowait((participant.identity, self._frames(stream)))

    def _on_unsubscribed(self, track: Any, publication: Any, participant: Any) -> None:
        stream = self._streams.pop(participant.identity, None)
        if stream is not None:
            asyncio.ensure_future(stream.aclose())

    @staticmethod
    async def _frames(stream: Any) -> AsyncIterator[Frame]:
        done = 0  # samples so far
        async for event in stream:
            pcm = np.frombuffer(event.frame.data, dtype=np.int16).copy()
            yield Frame(ts_ms=done * 1000 // RATE, pcm=pcm)
            done += len(pcm)

    async def tracks(self) -> AsyncIterator[tuple[str, AsyncIterator[Frame]]]:
        while (item := await self._new.get()) is not None:
            yield item

    async def disconnect(self) -> None:
        for stream in list(self._streams.values()):
            await stream.aclose()
        self._streams.clear()
        self._new.put_nowait(None)
        await self._room.disconnect()
