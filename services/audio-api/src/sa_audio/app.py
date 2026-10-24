from __future__ import annotations

import base64
import hmac
import io
import json
import sys
import time
from collections.abc import AsyncIterator
from typing import Annotated, Any

import httpx
import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from sa_audio import sentences
from sa_audio.stt import Transcript, transcribe
from sa_audio.tts import Router


def _log(event: str, **fields: Any) -> None:
    """One JSON line; counts, sizes and latencies only, never text or audio."""
    print(json.dumps({"event": event, **fields}), file=sys.stdout, flush=True)


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=4000)
    language: str = "en"
    voice: str | None = None
    stream: bool = False


def _wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def create_app(
    router: Router,
    stt_base_url: str,
    token: str,
    http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    app = FastAPI(title="sa-audio")
    client = http_client or httpx.AsyncClient(timeout=120.0)

    def auth(x_internal_token: Annotated[str | None, Header()] = None) -> None:
        if x_internal_token is None or not hmac.compare_digest(x_internal_token, token):
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.get("/healthz")
    async def healthz() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/v1/voices", dependencies=[Depends(auth)])
    async def voices() -> dict[str, dict[str, str]]:
        return router.voices()

    @app.post("/v1/audio/transcriptions", dependencies=[Depends(auth)], response_model=Transcript)
    async def transcriptions(
        file: Annotated[UploadFile, File()],
        language: Annotated[str, Form()] = "auto",
    ) -> Any:
        audio = await file.read()
        started = time.monotonic()
        try:
            result = await transcribe(
                client, stt_base_url, audio, file.filename or "audio.wav", language
            )
        except (httpx.TransportError, httpx.HTTPStatusError):
            _log("transcribe_failed", bytes=len(audio))
            return JSONResponse(status_code=503, content={"error": "stt_unavailable"})
        _log(
            "transcribe",
            bytes=len(audio),
            segments=len(result.segments),
            chars=len(result.text),
            ms=round((time.monotonic() - started) * 1000),
        )
        return result

    @app.post("/v1/audio/speech", dependencies=[Depends(auth)])
    async def speech(req: SpeechRequest) -> Response:
        if req.voice is not None and req.voice not in router.allowed_voices():
            raise HTTPException(status_code=422, detail="unknown voice")
        parts = sentences.split(req.input) or [req.input.strip()]
        engine = router.engine(req.language, req.voice)

        async def synth(text: str) -> np.ndarray:
            return await run_in_threadpool(engine.synth, text)

        if not req.stream:
            started = time.monotonic()
            chunks = [await synth(p) for p in parts]
            samples = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
            _log(
                "speech",
                sentences=len(parts),
                samples=int(samples.size),
                ms=round((time.monotonic() - started) * 1000),
            )
            return Response(_wav_bytes(samples, engine.sample_rate), media_type="audio/wav")

        async def lines() -> AsyncIterator[bytes]:
            for seq, text in enumerate(parts):
                started = time.monotonic()
                samples = await synth(text)
                wav = _wav_bytes(samples, engine.sample_rate)
                _log(
                    "speech_chunk",
                    seq=seq,
                    samples=int(samples.size),
                    ms=round((time.monotonic() - started) * 1000),
                )
                obj = {
                    "seq": seq,
                    "text": text,
                    "sample_rate": engine.sample_rate,
                    "wav_b64": base64.b64encode(wav).decode("ascii"),
                }
                yield (json.dumps(obj) + "\n").encode()

        return StreamingResponse(lines(), media_type="application/x-ndjson")

    return app
