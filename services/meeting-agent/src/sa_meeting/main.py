"""sa-meeting CLI: `join` runs the notetaker, `synth` plays a WAV into a room (smoke tests)."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

import httpx


async def _join() -> int:
    from .bridge_client import BridgeClient
    from .config import load
    from .room import LiveKitRoom
    from .segmenter import SileroSegmenter
    from .stt import SttClient
    from .worker import run

    cfg = load(os.environ, sys.stdin.readline())
    async with httpx.AsyncClient() as client:
        return await run(
            cfg,
            LiveKitRoom(),
            SileroSegmenter,
            SttClient(cfg.audio_url, cfg.audio_token, cfg.stt_language, client=client),
            BridgeClient(cfg, client),
        )


def run(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="sa-meeting")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("join")
    synth = sub.add_parser("synth")
    synth.add_argument("--url", required=True)
    synth.add_argument("--token-stdin", action="store_true", required=True)
    synth.add_argument("--wav", required=True)
    synth.add_argument("--delay-s", type=float, default=0.0)
    args = parser.parse_args(argv)
    if args.cmd == "join":
        sys.exit(asyncio.run(_join()))
    from .synth import play

    asyncio.run(play(args.url, sys.stdin.readline().strip(), args.wav, args.delay_s))
    sys.exit(0)
