"""Live smoke helper: join a room and play a WAV as a microphone, in real time."""

from __future__ import annotations

import asyncio
import wave

import numpy as np


async def play(url: str, token: str, wav_path: str, delay_s: float = 0.0) -> None:
    from livekit import rtc  # lazy: only the live extra has it

    with wave.open(wav_path, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    room = rtc.Room()
    await room.connect(url, token)
    try:
        source = rtc.AudioSource(16000, 1)
        track = rtc.LocalAudioTrack.create_audio_track("mic", source)
        await room.local_participant.publish_track(
            track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        )
        await asyncio.sleep(delay_s)
        step = 160  # 10 ms
        for i in range(0, len(pcm), step):
            chunk = pcm[i : i + step]
            await source.capture_frame(
                rtc.AudioFrame(
                    data=chunk.tobytes(),
                    sample_rate=16000,
                    num_channels=1,
                    samples_per_channel=len(chunk),
                )
            )
            await asyncio.sleep(0.01)
        await source.wait_for_playout()
    finally:
        await room.disconnect()
