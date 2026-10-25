"""The worker's view of the bridge: who may be heard, where segments go."""

from __future__ import annotations

import httpx

from .config import WorkerConfig


class BridgeClient:
    def __init__(self, cfg: WorkerConfig, client: httpx.AsyncClient) -> None:
        self._base = f"{cfg.bridge_url.rstrip('/')}/internal/calls/notetakers/{cfg.notetaker_id}"
        self._headers = {"X-Internal-Token": cfg.meeting_token}
        self._client = client

    async def state(self) -> tuple[str, set[str]]:
        r = await self._client.get(f"{self._base}/state", headers=self._headers, timeout=10)
        r.raise_for_status()
        body = r.json()
        return str(body["status"]), set(body.get("consented", []))

    async def post_segment(self, speaker: str, t0_ms: int, t1_ms: int, text: str, lang: str) -> int:
        """Returns the HTTP status; 403 (not consented) and 409 (not active) are not errors."""
        r = await self._client.post(
            f"{self._base}/segments",
            headers=self._headers,
            json={"speaker": speaker, "t0_ms": t0_ms, "t1_ms": t1_ms, "text": text, "lang": lang},
            timeout=10,
        )
        if r.status_code not in (403, 409):
            r.raise_for_status()
        return r.status_code

    async def report(self, state: str, detail: str | None = None) -> None:
        body: dict[str, str] = {"state": state}
        if detail:
            body["detail"] = detail[:200]
        await self._client.post(
            f"{self._base}/worker", headers=self._headers, json=body, timeout=10
        )
