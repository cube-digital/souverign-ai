from __future__ import annotations

import os
import sys

import uvicorn
from sa_infra import models_config

from sa_audio.app import create_app
from sa_audio.tts import Router


def run() -> None:
    token = os.environ.get("AUDIO_TOKEN")
    if not token:
        print('{"event": "startup_failed", "reason": "AUDIO_TOKEN unset"}', file=sys.stderr)
        raise SystemExit(1)
    cfg = models_config.load()
    stt = cfg["stt"]
    app = create_app(Router(cfg), f"http://{stt['host']}:{stt['port']}", token)
    uvicorn.run(
        app,
        host=os.environ.get("AUDIO_HOST", "127.0.0.1"),
        port=int(os.environ.get("AUDIO_PORT", "8645")),
        log_config=None,
        access_log=False,
    )
