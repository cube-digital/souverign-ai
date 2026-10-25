# Voice Agent in Calls Plan

**Goal:** a member clicks "Talk to <agent>" in a call (or in a DM with an agent) and the agent joins the LiveKit call, listens to the people who allow it, and answers by voice in under a second for small talk. It speaks a filler while its tools run, stops talking when someone interrupts, and keeps every tool behind the bridge's rules. A 1-day spike then decides whether a native speech-to-speech model (VoiceChat INT5) is worth a phase 2.
**Spec:** owner approval of 2026-10-25 ("make the in-call voice agent a livekit-agents worker with a streaming cascade (Parakeet, 9B, streaming TTS, filler, barge-in, E2EE), then the 1-day VoiceChat INT5 spike"); `.handoff/reports/Agenți vocali locali speech to speech.md` (recommendation, offline settings, E2EE notes, measurement design, day 1–3 plan) and its notes in `.handoff/research_notes/Agenți vocali locali speech to speech/`; `docs/superpowers/specs/decisions.md` D-2/D-3/D-4; `docs/relay/plans/2026-10-25-voice-meetings.md` (calls, consent, media key, notetaker worker, audio-api); `docs/relay/plans/2026-10-25-realtime.md` (V1/V2 placeholders, thinking policy, "never" flags); the owner's answers of 2026-10-25 (group rule, knowledge in 1:1 calls, E2EE optional, en/fr/de only, voice agent publishes audio).
**Runs after:** the voice + meetings plan is merged into the work branch (this plan edits its `calls/*`, `audio-api`, `CallPage` and protocol). It can run before or after connectors and realtime (see Overlaps). This plan's migration is `008_call_voice.sql` (connectors owns `007`).
**Architecture:** one long-running Python worker (`services/voice-agent`, package `sa_voice`) registers with the local LiveKit server as the `livekit-agents` agent `sa-voice`. The bridge dispatches it into a call room per voice session. It joins as `agent:<agentId>`, decrypts with the call's media key and subscribes only to people who allowed it. It runs Silero VAD and a floor router per speaker, streams the floor speaker's audio to Parakeet TDT v3 over a loopback WebSocket in audio-api, uses LiveKit's local `v1-mini` turn detector, and sends the final transcript to the bridge. The bridge decides whether to answer, then runs the turn itself: the 9B with thinking off, the agent's own tool catalog, tool results fed back. Deltas stream to the worker as NDJSON. The worker splits them into clauses, speaks each through audio-api's raw-PCM TTS endpoint and publishes the audio as the agent's microphone track. Barge-in cancels TTS and closes the turn stream, which aborts the LLM request.

## Rulings (decided in this plan)

- **R1, the brain: a direct bridge turn, not the Hermes gateway.** Voice turns run in the bridge (`agents/call-turn.ts`), calling the same LLM upstream the LLM proxy forwards to (`llmTarget()` in `agents/hermes.ts`). They use `chat_template_kwargs.enable_thinking = false`, `tool_choice: "auto"`, `max_tokens: 256` per round and at most 4 rounds. Tools come from the agent's own catalog, extracted from the MCP server so that both paths list and run the very same tools (`mcp/catalog.ts`, T5). Requester rules, approvals (`requestApproval` with the speaker as requester), per-agent allowlists and the `mcp tool` audit line all apply unchanged, because the tools are the same objects called with an explicit `ToolCtx`.
  - **Why:** Hermes turns take 45–62 s today. The same 9B answers the 9/9 ops questions in 6–8 s with 2–3 tool calls when called directly with thinking off (realtime plan, "Facts verified"). Its bare TTFT is ~0.15 s. Hermes runs the tool loop server-side, so the voice layer can't see tool starts. The direct path sees each tool call and can speak a matching filler. A voice turn also cannot wait behind the shared TurnQueue, where a 45 s text turn may be running.
  - **Cost:** two tool loops to maintain (Hermes for text, bridge for voice). Voice answers do not share Hermes' session memory or skills, so text and voice answers may differ in style. In group calls with `share: ask`, taught knowledge is not spoken (R8).
  - **Mitigation:** the same SOUL (`renderSoul`), the same tools and memory recall tools, and the ops9 tokens scored on the voice path in T14.
  - **Revisit when:** the realtime plan's tuned Hermes turns reach p50 ≤ 3 s for tool turns. Switching back is a follow-up plan, not a flag in this one.
- **R2, one worker, explicit dispatch.** Use the `livekit-agents` worker (not a per-call `rtc` process like the notetaker), because the local turn detector runs in the worker's inference process and needs a job context. The bridge spawns it once (lazily, on the first invite), it posts `ready`, and every session is an `AgentDispatch` with metadata `{"voice_agent_id": "<id>"}`. **Secrets never go into dispatch metadata.** LiveKit would see them, and the media key in particular would defeat E2EE. The worker fetches the media key from the bridge over loopback.
- **R3, filler in-band.** Fillers are not `session.say()`. That call would queue behind the pending reply and play after the answer. Instead the worker's bridge LLM stream injects the filler text as the first content of the reply, ending in `". "`, so the clause splitter flushes it at once. Fillers are spoken, interruptible, and reported separately (`filler_ms`), so `first_audio_ms` still means the first answer audio.
- **R4, privacy rules for calls.** These rules hold everywhere in this plan:
  - Only `accepted` people are subscribed. The inviter is accepted at invite. Everyone else gets the banner, and silence counts as not heard.
  - Decliners' tracks are never subscribed, so their audio never reaches VAD or STT. The bridge also refuses turns attributed to anyone not accepted (`not_consented`).
  - Decrypted PCM and transcripts move only over loopback (worker ↔ audio-api, worker ↔ bridge). The worker refuses non-loopback `AUDIO_URL` and `SA_BRIDGE_URL`.
  - Transcripts, spoken text and audio go into no log, perf entry, DB row or file. Per-session history lives in bridge memory and is dropped when the session ends.
  - What the agent may recall depends on who can hear it (R8).
- **R5, who it answers** (`calls/voice-rules.ts`, T6; approved by the owner on 2026-10-25). It answers:
  - (a) every utterance when one human is in the call (a 1:1 or agent-DM call);
  - (b) an utterance that names the agent at the start ("Hey Ops, …", reusing `addressesAgent`) or the end ("…, Ops?");
  - (c) a follow-up from the person it just answered, within 10 s of its last spoken reply.
  
  The tool requester is always the speaker. That matches the agent-teammates rules: answer when addressed, approvals go to the requester only. The inviter gets no extra answering rights in group calls, but anyone in the call can stop the agent.
- **R8, what the agent may know in a call** (owner ruling of 2026-10-25: "if I call an agent to talk with me, that agent has access to everything"). It is computed per turn by `voiceScope()` in `calls/voice-rules.ts` (T6, tested):
  - **1:1:** exactly one human is in the call (the speaker), and the speaker has a DM with the agent (when the call is held in that DM, it is the call's own chat). The turn runs with `chatId` = that DM and `noTaught: false`, so memory recall, taught knowledge and tools see exactly what the requester's DM sees. No share approval is asked, because only the requester hears, and in that DM the D-9 gate already posts (`oneToOneHuman`).
  - **Group:** two or more humans are in the call, or the speaker has no DM with the agent. `chatId` = the call's chat, and the group-chat rules apply:
    - `share: "always"` → `noTaught: false`.
    - `share: "ask"` or `"never"` → `noTaught: true`, so private taught knowledge is never spoken.
    - With `ask`, the turn also gets the voice-only tool `post_in_chat({question})` and an offer line in the prompt (T8). That tool starts a normal text turn of the agent in the call's chat, where the regular share gate and approval run.
  - A second person joining switches the next turn to group rules.
  - Voice turns never run the `beforeReply` hooks, because a streamed answer cannot be held. R8's `noTaught` is what keeps the gate's promise.
- **R6, components.**
  - VAD: Silero (`livekit-plugins-silero`, bundled).
  - Languages: the agent speaks English, French or German only (owner, 2026-10-25). Parakeet may transcribe other languages, but answers are always in the session language.
  - Turn detector: LiveKit's local turn detector pinned to `version="v1-mini"` for all three.
  - Interruption mode: `"vad"`.
  - STT: Parakeet TDT 0.6B v3 through `parakeet-mlx` (MLX) in audio-api, streaming. Whisper stays for voice messages and meeting notes.
  - TTS: the existing Kokoro-82M (mlx-audio, Apache-2.0) for en/fr and Piper `de_DE-thorsten-medium` for de, served as raw PCM per clause. Kokoro CoreML and Pocket TTS are not adopted here. T1 records their licence and languages, and T14 names CoreML as the follow-up if the load scenario shows GPU contention.
- **R7, no new LiveKit cloud paths.** `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `LIVEKIT_DEV_MODE` removed from the worker env, no LiveKit Inference keys, and turn detector weights pre-downloaded by `make models`. The bridge starts the worker under a macOS `sandbox-exec` profile that denies non-loopback network (`SA_VOICE_SANDBOX=auto`, on whenever `/usr/bin/sandbox-exec` exists).

## Memory budget (`fast` profile, M4 Max 36 GB)

| component | resident (est.) | new in this plan |
|---|---|---|
| Qwen3.5-9B 4-bit (vllm-mlx, the only LLM) | ~7 GB (5.5 weights + KV) | no |
| embeddinggemma (bf16, MPS) | ~1 GB | no |
| whisper large-v3-turbo q5 (voice messages, notes) | ~1 GB | no |
| Parakeet TDT 0.6B v3 (MLX, in audio-api) | ~1.5–2 GB | **yes** (download ~1.2 GB) |
| Kokoro-82M + the Piper de voice | ~0.45 GB | no |
| voice worker: main + 1 job process + inference process (Silero, v1-mini) | ~1–1.3 GB | **yes** (turn detector download ≤ 0.4 GB, T1 records the exact size) |
| LiveKit server, 5 Hermes gateways (~230 MB each), Postgres, bridge, relay, web | ~3 GB | no |
| **total** | **~15–16 GB** | **~3–3.3 GB** |

The gate (T14) is a total footprint of ≤ 30 GB during a call and a swap delta of ≤ 2 GiB. The spike (T15) adds VoiceChat INT5 (8.6 GB weights, a 15.6–23.7 GB footprint) on top of the 9B only, with the rest of the stack stopped.

## Global Constraints

- Conventions as in the earlier plans: TS `@sa/*`, NodeNext `.js` imports (web: Bundler, no extension), Biome, vitest, pytest + ruff. Commits `feat(voice-agent): …` / `test(voice-agent): …` / `docs(voice-agent): …` / `perf(voice-agent): …`, one per task.
- Only T1 changes `pyproject.toml` files, `uv.lock`, `package.json` files, `pnpm-lock.yaml`, the `Makefile`, `infra/models/*`, `config/models.yaml` and `.env.example`. A missing dependency means NEEDS_CONTEXT. T15 has its own `spikes/voicechat-int5/pyproject.toml`, which is **not** a workspace member, and its own lock.
- Local only: no new egress at runtime and no third-party URLs. Model downloads happen only in `make models` (T1) and in T15's own download step. System installers (`brew`, `uv tool install`, `curl | bash`, Xcode) are human steps, so a task that needs one reports NEEDS_CONTEXT.
- Only one big LLM is resident (the 9B). Nothing in this plan loads a second LLM, except the T15 spike, which runs alone and unloads afterwards.
- The vllm-mlx prefix cache stays off forever. Never `--enable-prefix-cache`, `--warm-prompts`, `--prefix-cache-size` or `--ssd-cache-dir`, even though the research suggests a warm prefix cache for TTFT.
- Public repo: no client company or product names and no absolute paths of this machine in any file or commit message. `git grep -inE "real[t]yme|gate[x]"` must print nothing before every commit.
- No transcript text, spoken text, audio, tool arguments, tokens or media keys in logs, perf data, result files or the DB (tool args follow the existing approvals and receipts rules). Log ids, sizes, durations, counts, states and reason codes.
- `make check` passes without models, without LiveKit and without audio-api. Python tests use fakes and `httpx.MockTransport` and never import `livekit` or `parakeet_mlx` at module top level. Bridge tests use fakes, injected spawners and a fake LLM server on `127.0.0.1:0`. Only T14 and T15 start the stack, LiveKit or models, each alone in its wave.
- Protected tests stay unchanged and green: `packages/protocol/test/protocol.test.ts`, `services/bridge/test/host.test.ts`, the MCP tests (`services/bridge/test/mcp*.test.ts`), the templates test, the memory and ops-sim tests, and every voice + meetings test. New tests go into new files. Any protected test going red → BLOCKED.
- `livekit-server` is installed on this Mac (owner, 2026-10-25). If T14 finds it missing, it returns BLOCKED with "livekit-server missing". It does not skip, because the measurements are the deliverable.
- Call E2EE stays as built: optional and off by default (`SA_CALL_E2EE=0`). This plan only makes the worker join an E2EE call when the call has a key, with the silent-key watchdog. Nothing else is E2EE-only.

## Overlaps with other plans

- **Voice + meetings (merged first):**
  - T6 edits `services/bridge/src/calls/store.ts` (`getCallInfo`, `endCall`).
  - T3 edits `services/audio-api/src/sa_audio/{app,tts,main}.py`.
  - T11 edits `apps/web/src/call/{CallPage,ConsentBanner,api,media,useCall}`.
  - T12 edits `apps/web/src/channel/ChannelHeader.tsx`.
  - T2 extends `CallInfo`/`CallEvent` in `packages/protocol/src/index.ts`.
  
  Read the merged files, and treat names in this plan's sketches that touch them as "verify in task".
- **Connectors:**
  - T5 edits `services/bridge/src/mcp/server.ts`, which connectors C6 also edits (registry seam, per-agent tools). `toolsForAgent(db, agentId)` is async and per agent so that it can include C6's per-agent connector tools: if C6 has landed, read its seam and include those tools; if not, whichever lands second merges by hand.
  - T1 appends a decision to `docs/superpowers/specs/decisions.md`, which C11 also edits.
  - T14's tool scenario uses `jira_search` only when connectors are merged, and skips it otherwise.
- **Realtime:**
  - This plan does not edit `services/bridge/src/llm-proxy.ts`, `agents/host.ts`, `agents/turn-queue.ts` or `services/bridge/src/voice/*`.
  - Voice turns bypass the proxy and the TurnQueue (R1), so realtime's round policy and perf store never see them. Their timings go to the separate `GET /internal/perf/voice`.
  - Realtime V1/V2 are **superseded by this plan**: V2's deliverable is this file, and V1's measurements are part of T14. The coordinator updates the realtime plan; no task here edits it.

## Review Focus

- A decliner's or not-yet-answered person's track is never subscribed (worker), and a turn attributed to them is refused (bridge `not_consented`). Switching to "Not me" unsubscribes within 2 s and drops a partial turn in progress.
- Nothing the agent hears is persisted or logged: grep the worker's and bridge's log calls for `text`, `transcript` and `delta`. The redaction filter drops third-party log messages. Session history is cleared on stop, end and failure.
- The media key is never in dispatch metadata, argv, env, the DB or logs. It travels only on `GET /internal/voice/:id/secret` (loopback + token).
- Voice tools are the same objects as MCP tools (T5 parity test). The requester is the speaker. R8's scope (the DM in 1:1, group rules otherwise) is recomputed per turn: with `share: ask` in a group, nothing taught is spoken. Voice turns never write into another turn's ToolLog or the `current` turn map.
- Barge-in closes the bridge stream, the LLM fetch aborts, and no further tool starts after the abort. A new turn of the same session aborts the previous one.
- E2EE failure is never silent: within 5 s of a subscribed, unmuted track without decrypted frames, the session shows `e2ee_failed`.
- Only one active voice agent per call, at most `SA_VOICE_MAX_SESSIONS` (2) in total, and the worker is respawned at most 3 times in 10 minutes. No worker process survives a bridge restart (pid file).
- The worker never publishes data, and it publishes audio only as the agent's microphone track (D-x in T1).

## Lanes notes

- T6, T8 and T9 are high risk, so their behaviors include the boundaries the skill asks for: the 9.9 s / 10.1 s follow-up, round-4 `tool_choice`, the clause word limits, and the floor hold and release times.
- T14 and T15 share a lane and run last, one after the other, with nothing else running. T14 writes `config/voice-agent.tuned.yaml`, not T9's file, so T9 stays in wave 2.

## Decided by the owner (2026-10-25)

1. R5, the group-call rule: the agent answers when named at the start or end of a sentence, plus a 10 s follow-up for the same person; in 1:1 calls it answers everything.
2. R8, knowledge: a 1:1 call has the requester's DM access, taught knowledge included and with no share approval. Group calls follow the chat's share rule.
3. Call E2EE stays optional and off by default. The worker joins an E2EE call with the call's key and runs the watchdog, and nothing more.
4. Voice languages are English, French and German. There is no Romanian voice or turn work in this plan.
5. D-x: the voice agent publishes audio in calls, next to D-4 (T1 records it as decided). `livekit-server` is installed.

Human steps left: Xcode command-line tools, only if T15 needs `speech-swift` (T15 step 2).

## Tasks

### T1: Dependencies, package skeleton, models, licences, sandbox profile, Make targets

**Workspace.** In the root `pyproject.toml`:
- add `services/voice-agent` to `[tool.uv.workspace].members`;
- add `sa-voice = { workspace = true }` to sources;
- add `"sa-voice"` to the `dev` group and `"sa-voice[live]"` to the `live` group;
- add `services/voice-agent/tests` to `testpaths`.

**`services/voice-agent/pyproject.toml`:**

```toml
[project]
name = "sa-voice"
version = "0.0.0"
description = "Sovereign Agents voice agent in calls: livekit-agents worker, floor router, bench harness"
requires-python = ">=3.12,<3.14"
dependencies = ["httpx>=0.27", "numpy>=1.26", "pydantic>=2.8", "pyyaml>=6"]

[project.optional-dependencies]
# exact pin: the offline settings (v1-mini, interruption "vad") depend on 1.8.x internals
live = ["livekit>=1.1", "livekit-agents[silero]==1.8.9", "websockets>=13"]

[project.scripts]
sa-voice = "sa_voice.main:run"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/sa_voice"]
```

Verify the local turn detector import in 1.8.9:
- `uv run --group live python -c "from livekit.agents.inference import TurnDetector"` (per the research, `livekit/agents/inference/eot/detector.py`).
- If it lives in `livekit-plugins-turn-detector` instead, add that package pinned to `==1.8.9` to `live`, and record which one it was in the ledger.

`websockets` is for the STT client. If `livekit-agents` already brings `aiohttp`, use that and drop `websockets`.

**audio-api.** Add `"parakeet-mlx>=0.3"` to the `models` extra in `services/audio-api/pyproject.toml`. Verify that the installed version has `transcribe_stream`, and record the version in the ledger.

**`services/voice-agent/src/sa_voice/__init__.py`**: an empty docstring module. **`services/voice-agent/src/sa_voice/main.py`** (complete; later tasks add modules and never edit this file):

```python
"""sa-voice CLI. Every subcommand imports its module lazily, so `make check` needs no livekit."""

from __future__ import annotations

import argparse
import importlib
import sys

COMMANDS = {
    "start": ("sa_voice.worker", "main"),  # the livekit-agents worker (T10)
    "download-files": ("sa_voice.worker", "download_files"),  # turn detector + VAD weights (T10)
    "fixtures": ("sa_voice.bench.fixtures", "main"),  # bench WAVs + manifest (T4)
    "bench-participant": ("sa_voice.bench.participant", "main"),  # scripted LiveKit user (T4)
    "calibrate-bot": ("sa_voice.bench.calibrate", "main"),  # harness self-check bot (T4)
    "load": ("sa_voice.bench.load", "main"),  # continuous 9B decode for the load scenario (T4)
}


def run(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(prog="sa-voice")
    parser.add_argument("command", choices=sorted(COMMANDS))
    ns, rest = parser.parse_known_args(args[:1])
    module, fn = COMMANDS[ns.command]
    code = getattr(importlib.import_module(module), fn)(args[1:] + rest)
    sys.exit(int(code or 0))
```

`services/voice-agent/tests/test_cli.py`: one test. `run(["nope"])` raises `SystemExit` with code 2, and `COMMANDS` holds exactly the six names above.

**`config/models.yaml`.** Add these keys, keeping `stt.meeting_fallback_repo`:

```yaml
stt:
  # … existing keys …
  streaming:
    repo: mlx-community/parakeet-tdt-0.6b-v3 # CC-BY-4.0; voice agent in calls, 25 EU languages
    approx_gb: 1.3
voice_agent:
  turn_detector:
    version: v1-mini # never unset: unset resolves to the cloud model in dev mode
    approx_gb: 0.4 # T1 replaces this with the measured size
```

**`infra/models/download.sh`.** After step 4, add:
- step 5: `hf "$(m get stt.streaming.repo)"`;
- step 6: `run uv run --no-sync --group live sa-voice download-files`. This is the only networked call of the worker. It runs with `HF_HUB_OFFLINE` unset, and T10's `download_files` sets nothing offline.

Print the measured sizes in the README model table (`infra/models/README.md`).

**`infra/voice/offline.sb`** (complete):

```scheme
(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
```

Check it in the task: `sandbox-exec -f infra/voice/offline.sb curl -sS -m 3 https://example.com` must fail, and `sandbox-exec -f infra/voice/offline.sb curl -sS -m 3 http://127.0.0.1:1 ; test $? -ne 6` must reach the connect stage, so the exit code is not 6, "couldn't resolve". If the `unix-socket` filter is rejected by this macOS, drop that line and record it.

**`Makefile`.** Add these targets:

```make
voice-bench: ## live: call voice agent latency harness (needs make up, make dev, make livekit); SCENARIOS=quiet,load,…
	pnpm --filter @sa/e2e exec tsx live/voice-agent-bench.ts $(if $(SCENARIOS),--scenarios $(SCENARIOS),)
voice-calibrate: ## live: harness self-check with a beep bot, no agent (needs make dev + make livekit)
	pnpm --filter @sa/e2e exec tsx live/voice-agent-bench.ts --calibrate
```

**`.env.example`.** Add these keys, commented, with defaults:
- `SA_VOICE_AGENT=worker` (`worker|fake|off`)
- `SA_VOICE_MAX_SESSIONS=2`
- `SA_VOICE_SANDBOX=auto` (`auto|1|0`)

**`docs/voice/models.md`.** Licences and portability:
- One row per component: Silero VAD, LiveKit turn detector v1-mini, Parakeet TDT 0.6B v3, parakeet-mlx, Kokoro-82M, mlx-audio, Piper + `de_DE-thorsten-medium`, Pocket TTS, Kokoro CoreML, livekit-agents, LiveKit server, VoiceChat 11B INT5.
- Columns: licence (read from the HF card or `LICENSE` file through `hf` / `curl https://huggingface.co/api/models/<repo>`, at build time only), languages, size, runtime (MLX / CoreML / ONNX CPU / Go), and **EC2 Mac**: "ok" for MLX/Metal/CoreML/CPU, "no" for anything CUDA.
- Then a short section, "Moving to an EC2 Mac":
  - everything in this plan runs on bare-metal Apple Silicon;
  - LiveKit needs `use_external_ip: false` + `node_ip` and the UDP range open in the security group;
  - Postgres must run without Docker Desktop there (a Homebrew or Postgres.app install, a human step);
  - the instance type's unified memory must be checked against the budget table, because it was not researched.
- Write the turn detector's licence as "LiveKit Model License (not OSI)".

**`docs/superpowers/specs/decisions.md`.** Append `D-x: the voice agent publishes audio in calls` (decided by the owner on 2026-10-25, next to D-4), using the next free D number. The text: the voice agent publishes only its microphone track and never data; its LiveKit dispatch token has the default agent grants; it hears only people who allowed it (R4); 1:1 calls have the requester's DM access, and group calls follow the chat's share rule (R8).

### T2: Protocol types and migration 008 (complete code)

In `packages/protocol/src/index.ts`, add this block **after** `CallInfo`'s dependencies (`ConsentDecision`, `CallParticipant`, `CallNotetaker`) and **before** `CallInfo`:

```ts
// ---- Voice agent in calls ----
export const VOICE_LANGS = ["en", "fr", "de"] as const;
export const VoiceLang = z.enum(VOICE_LANGS);
export type VoiceLang = z.infer<typeof VoiceLang>;
export const VoiceAgentStatus = z.enum(["active", "stopped", "finished", "failed"]);
export type VoiceAgentStatus = z.infer<typeof VoiceAgentStatus>;
export const VoiceWorkerState = z.enum(["starting", "joined", "left", "error", "e2ee_failed", "fake"]);
export type VoiceWorkerState = z.infer<typeof VoiceWorkerState>;

export const CallVoiceAgent = z.object({
  id: Id,
  agent_id: z.string(),
  agent_name: z.string(),
  invited_by: z.string(),
  invited_by_name: z.string(),
  language: VoiceLang,
  status: VoiceAgentStatus,
  worker: VoiceWorkerState,
  /** one entry per person who answered the banner; the inviter is "accepted" from the start */
  consents: z.array(z.object({ user_id: z.string(), decision: ConsentDecision })),
  stopped_by_name: z.string().nullable(),
});
export type CallVoiceAgent = z.infer<typeof CallVoiceAgent>;

/** Per-turn timings, ms. Measured by the worker; no text. */
export const VoiceTurnTiming = z.object({
  seq: z.number().int().nonnegative(),
  /** floor speaker's VAD end of speech → user turn committed */
  endpoint_ms: z.number().int().nonnegative(),
  /** VAD end of speech → final transcript */
  stt_ms: z.number().int().nonnegative(),
  /** user turn committed → first answer text from the bridge */
  first_token_ms: z.number().int().nonnegative().optional(),
  /** VAD end of speech → first filler audio frame published */
  filler_ms: z.number().int().nonnegative().optional(),
  /** VAD end of speech → first answer audio frame published */
  first_audio_ms: z.number().int().nonnegative().optional(),
  total_ms: z.number().int().nonnegative(),
  tools: z.array(z.string().max(64)).max(20),
  interrupted: z.boolean(),
});
export type VoiceTurnTiming = z.infer<typeof VoiceTurnTiming>;

/** Worker ↔ bridge (loopback, MEETING_TOKEN). */
export const VoiceSessionState = z.object({
  status: VoiceAgentStatus,
  call_id: Id,
  chat_id: Id,
  agent_id: z.string(),
  agent_name: z.string(),
  language: VoiceLang,
  e2ee: z.boolean(),
  /** LiveKit identities (`user:<id>`) that are accepted and in the call right now */
  consented: z.array(z.string()),
});
export type VoiceSessionState = z.infer<typeof VoiceSessionState>;
export const VoiceDecideRequest = z.object({
  seq: z.number().int().nonnegative(),
  /** LiveKit identity `user:<id>` of the floor speaker */
  speaker: z.string().regex(/^user:.+/),
  text: z.string().min(1).max(2000),
});
export type VoiceDecideRequest = z.infer<typeof VoiceDecideRequest>;
export const VoiceAnswerReason = z.enum([
  "one_to_one",
  "addressed",
  "follow_up",
  "not_addressed",
  "not_consented",
  "stopped",
]);
export type VoiceAnswerReason = z.infer<typeof VoiceAnswerReason>;
export const VoiceDecideResponse = z.object({ answer: z.boolean(), reason: VoiceAnswerReason });
export type VoiceDecideResponse = z.infer<typeof VoiceDecideResponse>;
/** One NDJSON line of `POST /internal/voice/:id/turn`. */
export const VoiceTurnEvent = z.discriminatedUnion("t", [
  z.object({ t: z.literal("delta"), text: z.string() }),
  z.object({ t: z.literal("tool"), name: z.string().max(64), phase: z.enum(["start", "end"]) }),
  z.object({ t: z.literal("done"), first_token_ms: z.number().int().nonnegative().optional() }),
  z.object({ t: z.literal("error"), code: z.enum(["timeout", "llm_failed", "aborted", "not_consented"]) }),
]);
export type VoiceTurnEvent = z.infer<typeof VoiceTurnEvent>;
export const VoiceSpokenRequest = z.object({
  seq: z.number().int().nonnegative(),
  speaker: z.string().regex(/^user:.+/),
  /** the user's final transcript and what the agent actually said (truncated at barge-in) */
  heard: z.string().max(2000),
  said: z.string().max(4000),
  timing: VoiceTurnTiming,
});
export type VoiceSpokenRequest = z.infer<typeof VoiceSpokenRequest>;
export const VoiceWorkerReport = z.object({
  state: VoiceWorkerState,
  reason: z.enum(["no_frames", "decryption_failed", "missing_key", "crashed", "stopped"]).optional(),
});
export type VoiceWorkerReport = z.infer<typeof VoiceWorkerReport>;
```

`CallInfo` gains `voice_agent: CallVoiceAgent.nullable().optional(),`. It is optional so that existing fixtures stay valid, and the bridge always sets it. `CallEvent` gains:

```ts
  z.object({
    type: z.literal("call.voice_turn"),
    call_id: Id,
    speaker_user_id: z.string(),
    timing: VoiceTurnTiming,
  }),
```

`services/bridge/src/migrations/008_call_voice.sql`:

```sql
create table sa.call_voice_agents (
  id text primary key,
  call_id text not null references sa.calls on delete cascade,
  agent_id text not null references sa.agents,
  invited_by text not null references sa.users,
  language text not null default 'en' check (language in ('en', 'fr', 'de')),
  status text not null default 'active' check (status in ('active', 'stopped', 'finished', 'failed')),
  worker text not null default 'starting'
    check (worker in ('starting', 'joined', 'left', 'error', 'e2ee_failed', 'fake')),
  stopped_by text references sa.users,
  answers int not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index call_voice_agents_one_active on sa.call_voice_agents (call_id) where status = 'active';
create index call_voice_agents_by_call on sa.call_voice_agents (call_id, started_at desc);

create table sa.call_voice_consents (
  voice_agent_id text not null references sa.call_voice_agents on delete cascade,
  user_id text not null references sa.users,
  decision text not null check (decision in ('accepted', 'declined')),
  decided_at timestamptz not null default now(),
  primary key (voice_agent_id, user_id)
);
```

If connectors' `007` has not landed, check that the migration runner applies files by sorted name and tolerates the gap. If it does not, report NEEDS_CONTEXT.

`packages/protocol/test/call-voice.test.ts` (3 tests):
1. a `CallInfo` without `voice_agent` still parses;
2. `VoiceDecideRequest` rejects `speaker: "agent:x"` and empty text;
3. a `call.voice_turn` event parses through `ServerEvent`.

### T3: audio-api: streaming Parakeet, raw-PCM TTS, one MLX lock

**`sa_audio/mlx_lock.py`:** `MLX_LOCK = threading.RLock()`. Kokoro's `_kokoro_lock` in `tts.py` becomes an alias of it, so Kokoro and Parakeet never run Metal work at the same time in one process. This is the Metal crash noted in the research.

**`sa_audio/parakeet.py`:**
- `class StreamingStt(Protocol)`: `def open(self) -> "SttStream"`. The returned `SttStream` has `add(pcm: np.ndarray[float32]) -> str` (returns the current text), `final() -> str` and `close()`.
- `ParakeetEngine(repo)` loads `parakeet_mlx.from_pretrained(repo)` lazily under `MLX_LOCK`.
- `open()` enters `model.transcribe_stream(context_size=(256, 256))`. Verify the API in the installed version, and record any rename.
- `add` calls `transcriber.add_audio(mx.array(pcm))` under the lock and returns `transcriber.result.text`.
- `final()` returns the text after the last add.
- `transcribe(pcm) -> str` runs one batch pass for the HTTP route.

**`sa_audio/stream.py`.** WebSocket `GET /v1/audio/transcriptions/stream?language=<hint>`:
- **Auth** is the `x-internal-token` header, the same token as HTTP. A wrong token closes with code 4401.
- **Client → server:**
  - binary frames: 16 kHz mono s16le PCM, any length; the server converts them to float32;
  - text `{"type":"flush"}`: end of utterance;
  - text `{"type":"reset"}`: drop the buffer.
- **Server → client:**
  - `{"type":"interim","text":…}`: after an `add`, at most every 300 ms, and only when the text changed;
  - `{"type":"final","text":…,"ms":<flush→final ms>}`: after `flush`, after which the stream is closed and reopened for the next utterance;
  - `{"type":"error","code":"stt_failed"}` on an exception.
- **Limits:** an utterance over 30 s of audio is force-finalised (a `final` is sent, then a fresh stream).
- **Logs:** only `{"event":"stt_stream_final","ms","audio_ms","chars"}`, with no text.
- `create_app(…, streaming_stt: StreamingStt | None = None)`. If `None`, the route closes with 4503. `main.py` passes `ParakeetEngine(cfg["stt"]["streaming"]["repo"])` when `parakeet_mlx` is importable, and `None` otherwise.

**`POST /v1/audio/transcriptions`** gains a form field `model: "whisper" | "parakeet" = "whisper"`. `parakeet` decodes the WAV with soundfile, resamples to 16 kHz (`numpy` linear is fine) and returns the same `Transcript` shape, with `language` echoing the hint.

**`POST /v1/audio/speech/pcm`:**
- **Body:** JSON `{text: 1–600 chars, language, voice?}`.
- **Response:** a `StreamingResponse` with media type `audio/L16`, headers `x-sample-rate: <engine rate>` and `x-channels: 1`, and a body of raw s16le streamed as produced.
- `TtsEngine` gains `synth_iter(text) -> Iterator[np.ndarray]`. Kokoro yields each `model.generate` result as it comes, and Piper yields once.
- **Markdown** is stripped with the existing `sentences.py` helper.
- **Logs:** `{"event":"speech_pcm","first_ms","ms","samples"}`, with no text.

**`POST /v1/audio/warmup`:** synthesises "Hello." in `en` and transcribes 0.5 s of silence through the streaming engine if present. It returns `{ok: true, ms}`.

Tests:
- `services/audio-api/tests/test_stt_stream.py`, with a fake `StreamingStt` (4 tests):
  1. auth refused with 4401;
  2. interim at most every 300 ms (fake clock);
  3. flush → final with `ms`, then a fresh stream for the next utterance;
  4. route closes with 4503 without an engine.
- `services/audio-api/tests/test_speech_pcm.py`, with a fake engine yielding 2 arrays (2 tests):
  1. the body is the concatenated s16le and the header carries the rate;
  2. over 600 chars → 422.

### T4: Bench harness core (Python): T0/T1, scenarios, stats, report, calibration bot, load

Package `sa_voice/bench/` (`__init__.py`, `signal.py`, `stats.py`, `fixtures.py`, `participant.py`, `calibrate.py`, `load.py`, `report.py`). `participant.py`, `calibrate.py` and `load.py` import `livekit` / `httpx` inside `main()`.

**`signal.py` (pure):**
- `FRAME_MS = 10`.
- `rms_dbfs(frame: np.ndarray[int16]) -> float` returns −120.0 for digital silence.
- `speech_end_ms(pcm: np.ndarray[int16], rate: int, threshold_dbfs: float = -40.0) -> int` returns the end of the last 10 ms frame above the threshold. This is T0's offset in the file.
- `first_sound_ms(frames: Iterable[tuple[int, np.ndarray]], threshold_dbfs: float = -45.0, min_frames: int = 2) -> int | None` takes `(t_ns, frame)` pairs and returns the timestamp of the first of `min_frames` consecutive frames above the threshold. That is T1.
- `silence_after(frames, t_from_ns, hold_ms=200) -> int | None` returns the first t ≥ t_from where the track stayed below −45 dBFS for `hold_ms`. That is the barge-in stop.

**`stats.py`:**
- `pct(values, p)` is nearest rank: `sorted(v)[ceil(p/100·n) − 1]`, and `None` for empty input.
- `summary(values) -> {n, p50, p95, min, max}`.

**`fixtures.py`** (`sa-voice fixtures --out <dir>`):
- It writes 16 kHz mono WAVs and `manifest.json` (`[{id, lang, kind: short|medium|long|tool|bargein|backchannel, file, end_ms, expect?: [tokens]}]`), synthesising through audio-api `POST /v1/audio/speech` (non-stream WAV, resampled to 16 kHz). `end_ms` comes from `speech_end_ms`.
- **Sets:**
  - EN: 10 short (< 2 s, e.g. "Hey Ops, are you there?"), 20 medium (2–6 s), 10 long (> 10 s, with a question at the end);
  - fr and de: 10 medium each;
  - tool: the ops9 questions, prefixed "Hey Ops, ", with `expect` set to the realtime plan's tokens: `node-3`; `db-2` + `node-1`; `7.4.0-rc2`;
  - plus `"Hey Ops, how are things?"` and, only when `jira_search` exists, one Jira lookup by id from the ops-sim story;
  - bargein: 20 interruptions ("Wait, stop. What about node two?");
  - backchannel: 20 × "mm-hm" / "okay" / "right", each ≤ 0.5 s.
- **Human recordings:** files in `$SA_MODELS_DIR/fixtures/voice-agent/human/<id>.wav` replace the synthetic one with the same id, and the manifest records `source: human|tts`.
- The sentence lists live in `fixtures.py` as constants. Write them yourself: plain ops and small-talk questions with no names of real companies.

**`participant.py`** (`sa-voice bench-participant`):
- **Input:** stdin JSON `{url, token, media_key|null, manifest, scenario, agent_identity, gap_s: 4, barge_at_s: 1.0}`.
- **Connect:** E2EE with `rtc.KeyProviderOptions(shared_key=…)`, decoding the key exactly as `sa_meeting.config` does. It publishes a mic track with `rtc.AudioSource(16000, 1, queue_size_ms=50)` (a small queue, so T0 is honest) and subscribes only to `agent_identity`.
- **For each utterance:**
  - push 10 ms frames in real time;
  - T0 = `time.time_ns()` when the frame that contains `end_ms` was handed to `capture_frame`, plus `queue_size_ms`;
  - T1 = `first_sound_ms` over the agent's received frames after T0;
  - wait for agent silence ≥ 1.5 s or 20 s, then `gap_s`.
- **Scenarios:**
  - `bargein` starts the bargein fixture `barge_at_s` after T1, then records `silence_after` from the start of that fixture's speech;
  - `backchannel` plays one backchannel 1.0 s after T1 and counts a false interruption when the agent goes silent for > 400 ms within 1.5 s.
- **Output:** one JSON line per utterance on stdout: `{id, lang, kind, t0_ns, t1_ns|null, mouth_to_ear_ms|null, barge_stop_ms?, false_interrupt?, agent_pcm_path?}`. For `tool` utterances it also keeps the agent's received audio as a temp WAV under `.run/bench/` for scoring, deleted by the orchestrator after scoring.

**`calibrate.py`** (`sa-voice calibrate-bot`): it joins with the given token, subscribes to one identity, and plays a 1 kHz, 300 ms beep exactly 800 ms after the last above-threshold frame (energy detector, 300 ms hangover). The harness expects `mouth_to_ear = 800 + transport`.

**`load.py`** (`sa-voice load --seconds N`): it streams `max_tokens: 512` completions with thinking off, straight to the LLM URL from `sa_infra.models_config` in a loop. It prints `{tokens, seconds, tok_s}` every 10 s and at the end.

**`report.py`:** `render(results: dict) -> str`. Markdown sections `## Setup`, `## Calibration`, `## Mouth-to-ear`, `## Under load`, `## Tool turns`, `## Barge-in`, `## E2EE`, `## Resources`, `## Offline`. Each has a table with the measured value, the gate and `PASS`/`FAIL`, and a missing scenario prints `not run`. The gates are fixed here:

| key | gate |
|---|---|
| `en_p50` / `en_p95` | ≤ 900 / ≤ 1300 ms |
| `frde_p50` | ≤ `en_p50` + 150 ms |
| `load_p50_degradation` | ≤ 20 % |
| `load_decode_ratio` | ≥ 0.8 of solo tok/s |
| `filler_ms` p95 | ≤ 1500 |
| `tool_answer_over_tool_ms` p50 | ≤ 1200 |
| `tool_correct` | all expected tokens present |
| `barge_stop_ms` p50 / p95 | ≤ 300 / ≤ 500 |
| `false_interrupts` | ≤ 1 / 20 |
| `e2ee_failure_explicit` (only with `SA_CALL_E2EE=1`) | wrong key → `e2ee_failed` ≤ 10 s |
| `footprint_gb` | ≤ 30 |
| `swap_delta_gib` | ≤ 2 |
| `offline_conns` | 0 |
| `calibration_offset_ms` | 0–120, jitter (p95 − p50) ≤ 40 |

Tests (4):
- `test_bench_signal.py`: `speech_end_ms` on a synthetic tone + silence is exact to 10 ms; `first_sound_ms` ignores a single-frame click.
- `test_bench_stats.py`: nearest rank, e.g. `pct([1..20], 95) == 19`, and empty → `None`.
- `test_bench_report.py`: a missing scenario renders `not run`, and a failing gate renders `FAIL`.

### T4b: Bench orchestrator (TypeScript)

`e2e/live/voice-agent-bench.ts` and `e2e/live/voice-agent-lib.ts`, run by `make voice-bench` / `make voice-calibrate` (T1).

**Setup:**
- Log in as the seeded users Ana and Ben the same way `e2e/live/call-smoke.ts` does (read it; copy the helpers if they are not exported).
- Open Ana's DM with Ops, start a call with a fresh media key (the same `meta.call` message as the web), get Ana's token, and invite the voice agent (`POST /api/calls/:id/voice-agent`, `language` per scenario).
- In `--calibrate` mode, get Ben's token and start `sa-voice calibrate-bot` as Ben instead of inviting the agent.
- Spawn `uv run --no-sync --group live sa-voice bench-participant` with the stdin JSON from T4. Read its JSON lines, and join them with `GET /internal/perf/voice` (loopback, `MEETING_TOKEN`) by `seq` order for the stage breakdown.

**Scenarios** (`--scenarios`, default all), each run with E2EE as the bridge is configured:
- `quiet`: EN 40.
- `lang`: fr and de, 10 each, with a new session per language.
- `load`: EN 40 while `sa-voice load` runs. Solo tok/s is measured first, 3 × 20 s.
- `tools`: score the received agent audio by transcribing it through audio-api (`model=parakeet`), in memory only, then delete the temp WAVs. The correctness is case-insensitive token containment.
- `bargein`: 20.
- `backchannel`: 20.
- `e2ee` (only when the bridge runs with `SA_CALL_E2EE=1`, else `not run`): quiet 10 with the call's key, then one invite with a wrong media key (32 random bytes), expecting `worker: "e2ee_failed"` in `GET /api/calls/:id` within 10 s.
- `resources`: every 5 s, the RSS sum of the process trees of vllm-mlx, audio-api, the voice worker, livekit-server and the bridge (`ps -o rss= -p` over `pgrep -P` trees), `sysctl vm.swapusage` and `pmset -g therm`.
- `offline`: the egress scan (`uv run --no-sync python -m sa_infra.egress` or the function `scan` from `sa_infra.egress`; read it) over the worker's pid tree (`.run/voice-worker.pid`) during the quiet run.

**Output:** `.run/perf/voice-agent-<ts>.json` and the Markdown from `report.render` (via `uv run --no-sync python -c`) printed to stdout. T14 pastes it into the perf doc. No text from the turns goes into either file.

Done: typecheck only, because running it is T14.

### T5: MCP catalog: one tool list and one run path for MCP and voice (test-author first)

`services/bridge/src/mcp/catalog.ts`:

```ts
export type DirectCtx = {
  db: Db;
  agentId: string;
  template: string;
  opsSimUrl: string;
  chatId?: string;
  requesterUserId?: string;
  turn?: TurnContext;
};
export type CatalogTool = {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  /** the MCP server's `raw` flag: string results go out as is */
  raw: boolean;
  run(ctx: DirectCtx, args: Record<string, unknown>): Promise<unknown>;
};
/** Exactly the tools (names, order, schemas) MCP tools/list returns to this agent. */
export function toolsForAgent(db: Db, agentId: string): Promise<{ template: string; tools: CatalogTool[] }>;
/** Same serialisation and audit line as the MCP CallTool handler; never touches ToolLog. */
export function runToolDirect(
  ctx: DirectCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; ms: number }>;
/** OpenAI `tools` array for chat completions. */
export function openAiTools(tools: CatalogTool[]): {
  type: "function";
  function: { name: string; description: string; parameters: object };
}[];
```

**Move and adapt.** Move the built-in tool list and the result serialisation (`raw` strings as is, else `JSON.stringify`, errors as `{"error":"tool_failed","message":…}`) out of `mcp/server.ts` into `catalog.ts`. Adapt the built-in tools' context `{db, agentId, opsSimUrl, chatId, requester}` from `DirectCtx`, and give registered tools (`registeredTools(template)`) their `ToolCtx`.

**Per-agent allowlist.** If connectors C6 is merged, include its per-agent seam here.

**`server.ts`.**
- `tools/list` and `CallTool` use `toolsForAgent` and one shared `serialise` helper.
- The ToolLog `accepts`/`record` checks stay in `server.ts`, unchanged.
- The `mcp tool` log line gains `via: "mcp"`, and `runToolDirect` logs the same line with `via: "voice"`. It logs no args and no result.

`services/bridge/test/mcp-catalog.test.ts` (5 tests):
1. for every template in `infra/hermes/templates`, MCP `tools/list` names and schemas equal `toolsForAgent`;
2. an unknown tool → `isError` with `unknown tool: x`;
3. a tool that throws → `tool_failed` and `isError`;
4. `runToolDirect` passes `requesterUserId` and `chatId` into a registered tool's ctx;
5. `runToolDirect` does not change `ToolLog.end(agentId)` of a running MCP turn.

The protected MCP tests stay green.

### T6: Bridge voice sessions: store, rules, public routes, plugin (test-author first)

**`services/bridge/src/calls/voice-rules.ts`** (complete):

```ts
import type { VoiceAgentStatus, VoiceAnswerReason } from "@sa/protocol";
import { addressesAgent } from "../agents/voice-trigger.js";

export const FOLLOW_UP_MS = 10_000;

export type DecideInput = {
  status: VoiceAgentStatus;
  speakerUserId: string;
  /** users with an accepted voice consent who are in the call right now */
  consentedInCall: readonly string[];
  /** humans in the call right now, consenting or not */
  humansInCall: number;
  agentName: string;
  text: string;
  lastAnswered: { userId: string; endedAt: number } | null;
  now: number;
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "…, Ops?" / "… right Ops." at the end of an utterance. */
export function endsWithName(text: string, agentName: string): boolean {
  return new RegExp(`[,\\s]@?${escapeRe(agentName)}\\W*$`, "i").test(text);
}

export function decideAnswer(i: DecideInput): { answer: boolean; reason: VoiceAnswerReason } {
  if (i.status !== "active") return { answer: false, reason: "stopped" };
  if (!i.consentedInCall.includes(i.speakerUserId)) return { answer: false, reason: "not_consented" };
  if (i.humansInCall <= 1) return { answer: true, reason: "one_to_one" };
  // STT writes "Q.A." for QA: compare without dots
  const text = i.text.replace(/\./g, "");
  if (addressesAgent(text, i.agentName) || endsWithName(text, i.agentName)) {
    return { answer: true, reason: "addressed" };
  }
  if (
    i.lastAnswered !== null &&
    i.lastAnswered.userId === i.speakerUserId &&
    i.now - i.lastAnswered.endedAt <= FOLLOW_UP_MS
  ) {
    return { answer: true, reason: "follow_up" };
  }
  return { answer: false, reason: "not_addressed" };
}

export type AgentShare = "never" | "ask" | "always";
export type VoiceScopeInput = {
  humansInCall: number;
  callChatId: string;
  /** the speaker's DM with this agent, or null */
  speakerDmChatId: string | null;
  agentShare: AgentShare;
};
export type VoiceScope = {
  mode: "one_to_one" | "group";
  /** the chat the turn's tools, recall and approvals run in */
  chatId: string;
  noTaught: boolean;
  /** offer `post_in_chat` instead of speaking taught knowledge */
  offerChat: boolean;
};

/** R8: a 1:1 call has the requester's DM access; a group call follows the chat's share rule. */
export function voiceScope(i: VoiceScopeInput): VoiceScope {
  if (i.humansInCall <= 1 && i.speakerDmChatId !== null) {
    return { mode: "one_to_one", chatId: i.speakerDmChatId, noTaught: false, offerChat: false };
  }
  return {
    mode: "group",
    chatId: i.callChatId,
    noTaught: i.agentShare !== "always",
    offerChat: i.agentShare === "ask",
  };
}
```

**`services/bridge/src/calls/voice-store.ts`.** SQL on the 008 tables:
- `inviteVoiceAgent(db, {callId, agentId, invitedBy, language}) → id`: an insert, plus an `accepted` consent for the inviter in one transaction. A unique violation → `CallError("voice_agent_active", 409)`.
- `voiceAgentOf(db, callId)`: the latest row.
- `setVoiceConsent`.
- `stopVoiceAgent(db, id, userId)` and `finishVoiceAgent(db, id, status)`, each guarded by `where status = 'active' returning`.
- `setVoiceWorker`.
- `incAnswers`.
- `consentedInCall(db, id) → userIds`: accepted and currently in the call.
- `activeVoiceSessions(db) → number`.
- `speakerDm(db, userId, agentId) → chatId | null`: the DM between that user and that agent, found the way the T1 agent-DM path finds it (read it).
- `agentShare(db, agentId) → AgentShare`: the same column `loadScopeInput` reads as `agent.share` (verify the column name).

Ids use the same id helper as `calls/store.ts`.

**`calls/store.ts`.** `getCallInfo` sets `voice_agent` (the latest row with its consents and names, or `null`). `endCall` finishes an active voice agent (`status='finished'`) in the same transaction, and the plugin's `onEnded` hook then stops the launcher.

**`services/bridge/src/calls/voice-session.ts`.** An in-memory session registry:
- `VoiceSessions`: `Map<vaId, {mediaKey: string | null, history: ChatMessage[], lastAnswered, inflight: AbortController | null}>`. History is capped at 24 messages (12 exchanges).
- `drop(vaId)` clears everything and is called on stop, finish and failure.
- The media key is never logged or stored.
- A `VoiceLauncher` interface: `{launch(vaId, callId): Promise<void>; stop(vaId): Promise<void>}`, with a no-op default that T7 replaces through `setVoiceLauncher`.

**`services/bridge/src/calls/voice-routes.ts`** (authenticated user routes):
- **`POST /api/calls/:id/voice-agent`** with `{agent_id, language?: VoiceLang = "en", media_key?: string}`:
  - the caller must be in the call, else 403 `not_in_call`;
  - the agent must be an active member of the call's chat (403 `agent_not_in_chat`) and its template not `scribe` (400 `not_a_voice_agent`);
  - `SA_VOICE_AGENT=off` → 503 `voice_agent_disabled`;
  - in `worker` mode, LiveKit down (`livekitAvailable`) → 503 `livekit_unavailable`;
  - `SA_CALL_E2EE=1` without `media_key` → 400 `media_key_required` (no dedicated test);
  - `activeVoiceSessions ≥ SA_VOICE_MAX_SESSIONS` (default 2) → 503 `voice_busy`;
  - on success: the row is created; in `fake` mode, `worker='fake'`; the media key goes into `VoiceSessions`; `launcher.launch` is called (failure → finish `failed`, 503 `voice_worker_unavailable`); `call.updated` goes to the call's participants; the reply is 201 `{voice_agent}`.
- **`POST /api/calls/:id/voice-agent/consent`** with `{decision: "accepted" | "declined"}`: a call participant only. It sets the consent and publishes `call.updated`.
- **`POST /api/calls/:id/voice-agent/stop`**: anyone in the call. It runs `stopVoiceAgent`, `launcher.stop` and `sessions.drop`, posts the receipt and publishes `call.updated`.
- **Receipt** (on stop and finish, only if `answers ≥ 1`): `agentHost.sendAs(agentId, chatId, {text})` with `reply_to` = the call anchor. The text is `Left the call · answered N times` (or `answered once`), followed by ` · tools: a ×2, b` when tools ran. Tool names come from the session's turn timings, so there is no text in them.

**`services/bridge/src/plugins/call-voice.ts`.** It registers the routes, holds the `VoiceSessions` singleton and exposes `voiceSessions()` / `setVoiceLauncher()` for T7. It hooks call end: if `calls/store.ts` exposes no event, call `finishVoiceAgent` from the plugin's existing end path, verify in task, and keep the edit inside `calls/store.ts`.

Tests:
- `services/bridge/test/call-voice-rules.test.ts` (6): one_to_one; addressed at the start; addressed at the end; "Q.A." matches `QA`; follow-up at 9.9 s yes and 10.1 s no; not_consented beats one_to_one.
- `services/bridge/test/call-voice-scope.test.ts` (4), the R8 ruling:
  1. one human with a DM → `one_to_one`, the DM's chat id, `noTaught: false`, no offer;
  2. one human without a DM → group rules;
  3. a group with `ask` → the call's chat, `noTaught: true`, `offerChat: true`;
  4. a group with `always` → `noTaught: false`, no offer.
- `services/bridge/test/call-voice-routes.test.ts` (6):
  1. invite → 201, inviter accepted, `call.updated`;
  2. second invite → 409;
  3. scribe → 400;
  4. not in call → 403;
  5. `voice_busy` at the limit;
  6. stop by a non-inviter participant works and the receipt is posted only with answers ≥ 1.

### T7: Bridge internal voice routes, worker supervisor, perf readout (test-author first)

**`services/bridge/src/calls/voice-internal.ts`.** Every route uses the guard of `/internal/calls/*` (loopback socket, loopback Host, no `x-forwarded-*`, `MEETING_TOKEN`). Import it, or copy it if it is not exported, without editing `internal-routes.ts`. The routes:
- `POST /internal/voice/worker/ready {pid}`: resolves the supervisor's readiness promise.
- `GET /internal/voice/:vaId/session` → `VoiceSessionState`. `consented` = `user:<id>` for `consentedInCall`.
- `GET /internal/voice/:vaId/secret` → `{media_key: string | null}`. Only while active, else 410.
- `POST /internal/voice/:vaId/worker` `VoiceWorkerReport`:
  - `joined` → `worker='joined'`;
  - `e2ee_failed` / `error` → `worker=<state>` and `status='failed'`, then `sessions.drop` and `call.updated`;
  - `left` while active → `failed`.
- `POST /internal/voice/:vaId/decide` `VoiceDecideRequest` → `decideAnswer(...)`. It logs the reason code only.
- `POST /internal/voice/:vaId/turn` `VoiceTurnRequest` (= the decide body) → `application/x-ndjson` of `VoiceTurnEvent`:
  - it re-checks consent first (`{"t":"error","code":"not_consented"}`, then ends);
  - it aborts the session's previous in-flight turn;
  - it creates an `AbortController` aborted on `req.raw` close, and calls T8's `callTurn` with an `emit` that writes one line per event and flushes at once.
  - Speaker names come from the call's participants, and `participants` holds the consenting in-call names.
  - The scope is computed per turn: `voiceScope({humansInCall, callChatId, speakerDmChatId: speakerDm(...), agentShare: agentShare(...)})`, passed to `callTurn` as `scope`.
- `POST /internal/voice/:vaId/spoken` `VoiceSpokenRequest`:
  - appends `{role:"user", content:"<Speaker>: <heard>"}` and `{role:"assistant", content: said}` to the session history, skipping an empty `said`;
  - `incAnswers` if `said` is non-empty, and sets `lastAnswered = {speaker, now}`;
  - pushes `{va_id, call_id, seq, timing, at}` into the perf ring;
  - publishes `call.voice_turn` to the users currently in the call.
- `GET /internal/perf/voice` → the last 200 ring entries (no text).

**`services/bridge/src/calls/voice-worker.ts`** (`VoiceWorkerSupervisor implements VoiceLauncher`; the `Spawner` from `calls/notetaker.ts` is injected):
- **`ensure()`**: if no live worker, spawn `uv run --project <repo root> --no-sync --group live sa-voice start`, prefixed by `sandbox-exec -f <repo>/infra/voice/offline.sb` when `SA_VOICE_SANDBOX` is `1`, or `auto` with `/usr/bin/sandbox-exec` present.
  - Env: `PATH`, `HOME`, `LIVEKIT_URL`, `SA_BRIDGE_URL` (`http://127.0.0.1:<bridge port>`), `AUDIO_URL`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and `SA_MODELS_DIR` / `HF_HOME` when set. Never `LIVEKIT_DEV_MODE`.
  - Stdin: one JSON line `{"livekit_api_secret":…, "meeting_token":…, "audio_token":…}`.
  - Wait for `ready` ≤ 20 s, else kill it and throw `voice_worker_unavailable`.
  - Pid file `.run/voice-worker.pid`. Plugin init kills a leftover.
  - Spawn at most 3 times per 10 min, else throw.
  - On exit, mark every active session `failed` / `worker='error'` and publish `call.updated`.
- **`launch(vaId, callId)`**: `ensure()`, then `AgentDispatchClient(httpUrl(LIVEKIT_URL), "sa-dev", secret).createDispatch(roomName(callId), "sa-voice", {metadata: JSON.stringify({voice_agent_id: vaId})})` behind an injectable `VoiceRoomOps` interface (`dispatch`, `removeParticipant`). `httpUrl` maps `ws(s)://` to `http(s)://`.
- **`stop(vaId)`**: the worker sees `status != active` within 2 s (session polling). After 3 s, `removeParticipant(room, "agent:<agentId>")` runs as a hard stop.
- **Fake mode**: `SA_VOICE_AGENT=fake` installs no supervisor, so the no-op launcher stays. `/turn` uses an echo brain instead of `callTurn`: `You said: <text>` in 3 `delta` lines, then `done`. This is so that e2e (T13) runs without an LLM.

**`plugins/call-voice.ts`** registers the internal routes and installs the supervisor in `worker` mode.

Tests:
- `services/bridge/test/call-voice-internal.test.ts` (7):
  1. non-loopback / wrong token → 403;
  2. `secret` after stop → 410;
  3. `turn` from a declined speaker → `not_consented` line;
  4. a second `turn` aborts the first (the fake `callTurn` sees its signal aborted);
  5. a client close aborts the signal;
  6. `spoken` publishes `call.voice_turn` only to in-call users and leaves no text in the perf ring;
  7. `e2ee_failed` → status failed and history dropped.
- `services/bridge/test/call-voice-worker.test.ts` (4):
  1. the spawn args carry the sandbox prefix with `auto` + present binary, and the stdin has the secrets while env has none of them;
  2. ready timeout → kill + throw;
  3. spawn limit;
  4. worker exit fails active sessions.

### T8: The brain: direct call turn with tools (test-author first)

**`services/bridge/src/agents/call-turn-llm.ts`.** A streaming OpenAI-compatible client:

```ts
export type LlmMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type RoundResult = { text: string; toolCalls: { id: string; name: string; arguments: string }[] };
export function streamRound(
  o: { baseUrl: string; model: string; fetch?: typeof fetch },
  body: { messages: LlmMessage[]; tools: object[]; toolChoice: "auto" | "none" },
  onText: (delta: string) => void,
  signal: AbortSignal,
): Promise<RoundResult>;
```

**Request body:** `{model, messages, tools, tool_choice, stream: true, temperature: 0.3, max_tokens: 256, chat_template_kwargs: {enable_thinking: false}}`. Omit `tools` when empty.

**Parsing SSE:** `\n\n` or `\r\n\r\n` boundaries and `data: [DONE]`.
- Content deltas pass through `visibleStream`-style think stripping. Reuse `splitThink` / `visibleStream` from `agents/runtime.ts`, so nothing inside `<think>` is ever emitted.
- `tool_calls` deltas are accumulated by `index` (`id`, `function.name`, `function.arguments` fragments).
- A non-200 response throws `LlmError(status)`.

**`services/bridge/src/agents/call-turn.ts`:**

```ts
export type CallTurnDeps = {
  db: Db;
  llm: { baseUrl: string; model: string };
  opsSimUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
};
export type CallTurnInput = {
  vaId: string;
  seq: number;
  agentId: string;
  callChatId: string;
  /** R8, from T6's voiceScope(); typed structurally here so this file does not import calls/ */
  scope: { mode: "one_to_one" | "group"; chatId: string; noTaught: boolean; offerChat: boolean };
  anchorMessageId: string | null;
  speaker: { userId: string; name: string };
  participants: string[];
  language: VoiceLang;
  history: ChatMessage[];
  text: string;
  signal: AbortSignal;
  emit: (e: VoiceTurnEvent) => void;
};
export function callTurn(
  deps: CallTurnDeps,
  input: CallTurnInput,
): Promise<{ said: string; tools: string[]; firstTokenMs?: number }>;
```

**Agent loading.** Load the agent the way `host.ts` builds its `RuntimeAgent` (read it; query the same columns, and do not edit `host.ts`). The system prompt is `renderSoul(agent)` + `\n\n` + `VOICE_ADDENDUM`, where `VOICE_ADDENDUM` is exactly:

```
You are speaking in a live voice call, not writing in chat. Answer in one to three short spoken sentences. No markdown, lists, tables, code, links or emoji. Say numbers and identifiers so they are easy to hear. If you need a tool, call it without announcing it. If an answer would be long, give the gist and offer to write the details in the chat. Each user message starts with the speaker's name. People in this call: {participants}. Speak {language name}.
```

`{language name}` is English, French or German. With `scope.offerChat`, append: `If the answer needs what people taught you, do not say it; offer to post it in the chat thread, where it can be approved, and call post_in_chat if they agree.` Messages are the system prompt, then `history`, then `{role:"user", content:"<speaker name>: <text>"}`.

**Loop:**
- Up to 4 rounds. Round 4 uses `toolChoice: "none"`.
- Text deltas → `emit({t:"delta"})`, and the first one sets `firstTokenMs`.
- Tool calls: at most 3 per round, run in order. For each: `emit({t:"tool",name,phase:"start"})`, then `runToolDirect(ctx, name, JSON.parse(arguments) or {})`, then `emit({t:"tool",name,phase:"end"})`. The result content goes back as a `tool` message, cut at 4000 chars.
- `ctx` = `{db, agentId, template, opsSimUrl, chatId: scope.chatId, requesterUserId: speaker.userId, turn}`, where `turn` is a `TurnContext`:
  - `turnId: "voice-<vaId>-<seq>"`, `agentName`, `chatId: scope.chatId`, `replyTo` (the call anchor when `scope.chatId === callChatId`, else `null`), `triggerMessageId: null`, `requesterUserId: speaker.userId`, `prompt: text`, `noTaught: scope.noTaught`;
  - `trigger`: the closest existing `TurnTrigger` value (verify; record it).
- Never call `addTurnHooks` hooks, and never write the turn into `turn-hooks`' `current` map.
- **`post_in_chat({question: string ≤ 500})`** is a voice-only tool, added to the round's tools only when `scope.offerChat`. It starts a normal text turn of the agent in the call's chat (requester = speaker, prompt = question, a reply in the call thread), so the regular share gate and approval run. It returns `"Posted in the chat thread."`.
  - It uses `AgentHostApi.runProactive` if `ProactiveRequest` can carry prompt, requester and reply-to (verify). If it cannot, leave the tool out and say instead, in the offer line, "ask me in the chat thread". Record which way it went in the ledger. Do not edit `host.ts`.

**Abort and timeouts:**
- On `signal` abort: stop at once, start no further tool, `emit({t:"error",code:"aborted"})`, and return what was emitted.
- A round over 30 s or a turn over 90 s → `emit({t:"error",code:"timeout"})`.
- An LLM failure → `llm_failed`.
- The last event is always `done` or `error`.

**Logs:** `{msg:"call turn", va, seq, rounds, tools: names, ms, first_token_ms}` and nothing else.

Tests, with a fake OpenAI server on `127.0.0.1:0` that serves scripted SSE:
- `services/bridge/test/call-turn-llm.test.ts` (4):
  1. `\r\n\r\n` boundaries;
  2. tool-call fragments over 3 chunks are assembled;
  3. `<think>…</think>` is never emitted;
  4. a 500 throws `LlmError`.
- `services/bridge/test/call-turn.test.ts` (7):
  1. the request carries `enable_thinking:false`, `max_tokens:256` and the addendum;
  2. a tool round emits start/end, then answer deltas;
  3. a registered tool sees `requesterUserId` = the speaker, and `chatId` / `turn.noTaught` from the scope: the DM and `false` for `one_to_one`, the call chat and `true` for a group with `ask`;
  4. round 4 has `tool_choice:"none"`;
  5. an abort during a tool → no second tool runs and the last event is `aborted`;
  6. timeout → `timeout`;
  7. `turn-hooks` `currentTurn(agentId)` is unchanged during the turn;
  8. a group scope with `offerChat` sends `post_in_chat` and the offer line, and a `one_to_one` scope sends neither.

### T9: Voice worker pure modules: config, clauses, filler, floor, watchdog, bridge client, redaction

**`config/voice-agent.yaml`** (the defaults; T14 writes its kept values to `config/voice-agent.tuned.yaml`, never to this file):

```yaml
# Voice agent in calls (services/voice-agent). Values are seconds unless the key ends in _ms.
vad: { min_speech_duration: 0.1, min_silence_duration: 0.3, activation_threshold: 0.5 }
turn:
  detector: v1-mini # never unset: unset resolves to the cloud model in dev mode; covers en, fr, de
  min_endpointing_delay: 0.3
  max_endpointing_delay: 2.5
interruption:
  mode: vad # "adaptive" needs LiveKit Cloud
  min_duration: 0.5
  min_words: 1
  resume_false_interruption: true
  false_interruption_timeout: 1.0
  other_speaker_ms: 600
floor: { release_ms: 900, hold_max_ms: 2500 }
clauses: { first_min_words: 4, first_max_words: 9, next_max_words: 25 }
filler: { after_ms: 1200, min_gap_ms: 4000, progress_after_ms: 6000, progress_every_ms: 8000, max_per_turn: 3 }
watchdog: { no_frames_ms: 5000 }
stt: { chunk_ms: 160 }
```

**`sa_voice/config.py`:**
- `VoiceConfig` (pydantic) is built from the yaml file (`SA_VOICE_CONFIG` or `<repo>/config/voice-agent.yaml`), deep-merged with `config/voice-agent.tuned.yaml` when that file exists (T14 writes it; keys not in the base file are an error), the env (`LIVEKIT_URL`, `SA_BRIDGE_URL`, `AUDIO_URL`, `SA_LIVEKIT_NODE_IP`) and one stdin JSON line (`livekit_api_secret`, `meeting_token`, `audio_token`).
- `check_loopback(url)`: the host must be `127.0.0.1`, `::1` or `localhost`, else `SystemExit(2)` with `{"event":"startup_failed","reason":"non_loopback_<name>"}`. It applies to `SA_BRIDGE_URL` and `AUDIO_URL` always, and to `LIVEKIT_URL` unless `SA_LIVEKIT_NODE_IP` is set.
- `offline_env(environ) -> dict` sets `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`, and removes `LIVEKIT_DEV_MODE` and every `LIVEKIT_INFERENCE_*` key.

**`sa_voice/clauses.py`** (complete):

```python
"""Split streamed LLM text into speakable chunks: the first at a clause, the rest at sentences."""

from __future__ import annotations

import re

_ANY_END = re.compile(r"(?:[,;:–—.!?…](?=\s)|\n\s*\n)")
_SENTENCE_END = re.compile(r"(?:[.!?…](?=\s)|\n\s*\n)")
_WORD = re.compile(r"\S+")
_MD = [
    (re.compile(r"```.*?```", re.S), " "),
    (re.compile(r"`([^`]*)`"), r"\1"),
    (re.compile(r"\[([^\]]+)\]\([^)]+\)"), r"\1"),
    (re.compile(r"https?://\S+"), "the link"),
    (re.compile(r"^\s*(?:[-+]|\d+\.)\s+", re.M), ""),
    (re.compile(r"[*_#>|~]+"), " "),
]


def speakable(text: str) -> str:
    for pattern, repl in _MD:
        text = pattern.sub(repl, text)
    return re.sub(r"\s+", " ", text).strip()


class ClauseSplitter:
    def __init__(self, first_min_words: int = 4, first_max_words: int = 9, next_max_words: int = 25):
        self.first_min_words = first_min_words
        self.first_max_words = first_max_words
        self.next_max_words = next_max_words
        self._buf = ""
        self._first = True

    def push(self, delta: str) -> list[str]:
        self._buf += delta
        out: list[str] = []
        while (chunk := self._take()) is not None:
            if chunk:
                out.append(chunk)
        return out

    def flush(self) -> list[str]:
        rest = speakable(self._buf)
        self._buf = ""
        if rest:
            self._first = False
        return [rest] if rest else []

    def _take(self) -> str | None:
        buf = self._buf
        if self._first:
            pattern, min_words, max_words = _ANY_END, self.first_min_words, self.first_max_words
        else:
            pattern, min_words, max_words = _SENTENCE_END, 1, self.next_max_words
        for m in pattern.finditer(buf):
            if len(buf[: m.end()].split()) >= min_words:
                return self._emit(m.end())
        words = list(_WORD.finditer(buf))
        if len(words) > max_words:  # a word after the limit proves the limit word is complete
            return self._emit(words[max_words - 1].end())
        return None

    def _emit(self, pos: int) -> str:
        chunk = speakable(self._buf[:pos])
        self._buf = self._buf[pos:].lstrip()
        if chunk:
            self._first = False
        return chunk
```

**`sa_voice/filler.py`** (pure; times in ms from the user turn commit):
- `FillerPolicy(cfg, language)` with:
  - `on_tick(now) -> str | None`;
  - `on_tool(name, phase, now) -> str | None`;
  - `on_answer_text(now)`, which stops all fillers once answer text has started.
- **Rules:**
  - The first filler fires at `after_ms` with no answer text yet, or at the first tool `start`, whichever is first.
  - The next ones are progress lines after `progress_after_ms` of a still-running tool, then every `progress_every_ms`.
  - Fillers are at least `min_gap_ms` apart and at most `max_per_turn` per turn.
- **Phrases.** en uses a tool map (an unknown tool or the timer gives `One moment.`):
  - `cluster_health`: "Checking the cluster."
  - `jira_search` / `jira_get_issue`: "Looking in Jira."
  - names starting `calendar_`: "Checking the calendar."
  - names starting `gitlab_`: "Checking GitLab."
  - `memory_recall` / `knowledge_search`: "Let me look that up."
  
  Progress in en is "Still working on it." For other languages, every filler is `fr` "Un instant." / `de` "Einen Moment.", and progress is `fr` "Je m'en occupe encore." / `de` "Ich bin noch dran.".
- Each phrase is returned with a trailing `" "`, so the splitter flushes it.

**`sa_voice/floor.py`** (pure state machine, times in ms):
- `FloorRouter(cfg)` with:
  - `set_allowed(identities: set[str]) -> list[Action]`;
  - `on_vad(identity, speaking: bool, now) -> list[Action]`;
  - `on_tick(now, user_turn_pending: bool, agent_speaking: bool) -> list[Action]`.
- `Action` is one of `Subscribe(id)`, `Unsubscribe(id)`, `Floor(id | None)`, `DropTurn()` and `Interrupt()`.
- **Subscriptions:** subscribed == allowed, always. A removed identity → `Unsubscribe`, and if it held the floor, `Floor(None)` + `DropTurn()`.
- **Floor:**
  - With exactly one allowed identity, it holds the floor permanently.
  - Otherwise, a free floor goes to the first allowed identity whose VAD turns on.
  - The floor is released after `release_ms` of the holder's silence, but not while `user_turn_pending`, up to `hold_max_ms`.
- **Interrupts:** while `agent_speaking`, a non-floor allowed identity speaking for ≥ `other_speaker_ms` → `Interrupt()`, once per agent speech.
- **Audio:** the floor's identity is the only one whose frames reach STT.

**`sa_voice/watchdog.py`** (pure):
- `E2eeWatchdog(no_frames_ms, e2ee: bool)` with:
  - `on_subscribed(id, now)`;
  - `on_muted(id, muted, now)`;
  - `on_frame(id, now)`;
  - `on_state(id, state: str, now)`;
  - `check(now) -> str | None` (a reason).
- **Failure reasons:**
  - `decryption_failed` / `missing_key` as soon as `on_state` reports those states (the livekit `EncryptionState` names, mapped in T10);
  - `no_frames` when an E2EE session has a subscribed, unmuted identity with no frame for `no_frames_ms` since subscribe or unmute.
- With E2EE off, only `no_frames` applies, and it is reported as a warning event without failing.

**`sa_voice/bridge_client.py`:**
- `BridgeClient(base_url, token, client: httpx.AsyncClient)`, using the same auth header as `sa_meeting.bridge_client`.
- `ready(pid)`, `session(va) -> VoiceSessionState`, `secret(va) -> bytes | None` (decoded like `sa_meeting.config`), `decide(...)`, `spoken(...)` and `report(va, state, reason=None)`.
- `turn(va, seq, speaker, text) -> AsyncIterator[dict]` streams NDJSON lines with `client.stream`. Closing the iterator closes the response, which is how barge-in aborts the bridge turn.
- Every request has a 5 s timeout except `turn` (read timeout 95 s).

**`sa_voice/redact.py`:** `install()`. Our own logger emits only JSON events via `log(event, **fields)`, with keys from the allow-list `{event, va, seq, ms, n, state, reason, identity_count, chars, samples, code, level, logger}`; other keys are dropped. Every other logger (`livekit*`, `httpx`, `websockets`) is set to WARNING, and its records are re-emitted as `{"event":"lib","logger":name,"level":…}` **without the message or args**.

Tests:
- `test_clauses.py` (5):
  1. `["Node three is at ninety percent,"]` after pushing `"Node three is "` and `"at ninety percent, and the disk "`;
  2. the next push `"is filling. Check it soon."` → `["and the disk is filling."]`, and flush → `["Check it soon."]`;
  3. 11 words without punctuation → the first 9;
  4. `"Yes, it is up. "` → one chunk (the clause at 1 word is below the minimum);
  5. `"**Node-3** is hot. "` → `"Node-3 is hot."`.
- `test_filler.py` (4): the timer at 1200 ms; a tool start earlier wins; the gap and max per turn; nothing after answer text.
- `test_floor.py` (5):
  1. a decliner is never subscribed;
  2. withdrawing consent while holding the floor → Unsubscribe + Floor(None) + DropTurn;
  3. a single identity holds the floor permanently;
  4. release after 900 ms but held while a turn is pending, up to 2500;
  5. another speaker for 600 ms during agent speech → one Interrupt.
- `test_watchdog.py` (2): no frames for 5 s with E2EE → `no_frames`; a muted identity never fails.
- `test_bridge_client.py` (2): turn NDJSON parsing; closing the iterator closes the response (MockTransport).
- `test_config.py` (2): a non-loopback `AUDIO_URL` exits with code 2; the tuned overlay overrides one key, and an unknown key is an error.
- `test_redact.py` (2):
  1. an INFO livekit log with a sentence in its message and args produces no output containing that sentence;
  2. our `log()` drops a `text=` field.

### T10: Voice worker on livekit-agents: STT, TTS, bridge LLM, audio input, session, E2EE

All of this lives in modules that import `livekit` at top level, so tests import them only behind `pytest.importorskip("livekit.agents")`. Pure helpers stay testable without livekit.

**`sa_voice/stt_parakeet.py`:**
- `ParakeetSTT(stt.STT)` with capabilities `streaming=True, interim_results=True`.
- `stream()` opens the T3 WebSocket (`ws://<AUDIO_URL host>/v1/audio/transcriptions/stream?language=<lang>`, header `x-internal-token`).
- It resamples input frames to 16 kHz mono with `rtc.AudioResampler`, and sends binary chunks of `stt.chunk_ms`.
- `interim` messages → `SpeechEventType.INTERIM_TRANSCRIPT`, and `final` → `FINAL_TRANSCRIPT`.
- `flush()` is triggered by the worker when the floor's VAD reports end of speech: call it from the audio input, verify how 1.8.9 drives stream flush, and record it.
- A reconnect on drop is allowed once per utterance.

**`sa_voice/tts_audio_api.py`:**
- `AudioApiTTS(tts.TTS)` (non-streaming `ChunkedStream`) posts to `/v1/audio/speech/pcm` and pushes frames as bytes arrive, at the rate in `x-sample-rate`. The worker publishes at 24 kHz, and Piper's 22.05 kHz is resampled with `rtc.AudioResampler`.
- `CallAgent.tts_node(text, model_settings)` is overridden. It feeds the text stream through `ClauseSplitter` (T9, with the config values) and synthesises each chunk in order with `AudioApiTTS`, so the first clause is spoken before the sentence ends.
- It records the publish time of the first audio frame of the first filler chunk and of the first answer chunk.

**`sa_voice/bridge_llm.py`:**
- `BridgeLLM(llm.LLM)`, where `chat(chat_ctx, tools=…, …)` returns `BridgeLLMStream`.
- Its `_run` takes the pending `(seq, speaker, text)` stashed by `CallAgent.on_user_turn_completed`, iterates `bridge.turn(...)`, and feeds `FillerPolicy` (T9) on a 100 ms tick and on `tool` events.
- Fillers and `delta` text are sent as `ChatChunk` content deltas, fillers first (R3).
- `error` events speak one fixed line: en "Sorry, that took too long." for `timeout`, and "Sorry, I couldn't answer that." otherwise, translated for fr/de.
- Cancellation (barge-in) closes the iterator, and so the HTTP stream.

**`sa_voice/audio_input.py`:**
- `FloorAudioInput(io.AudioInput)` yields only frames of the current floor identity.
- `RoomAudio` subscribes and unsubscribes per `FloorRouter` actions (`auto_subscribe` off). It runs one Silero VAD stream per subscribed identity, from the prewarmed VAD, and drives `FloorRouter.on_vad`.
- On `DropTurn`, it calls the session's clear-user-turn API (verify the name in 1.8.9).
- On `Interrupt`, it calls `session.interrupt()`.
- It polls `bridge.session()` every 2 s and passes `consented` to `set_allowed`. A status other than `active` → leave.

**`sa_voice/session_options.py`** (pure, testable without livekit): `session_kwargs(cfg, language) -> dict`. It maps `config/voice-agent.yaml` to the `AgentSession` keyword arguments of livekit-agents 1.8.9 (read the installed signature and record the mapping in the module docstring):
- `turn_detection = {"kind": "model", "version": "v1-mini"}` for every session language (en, fr, de);
- interruption mode `"vad"`;
- `allow_interruptions=True`;
- the min duration and words, false-interruption resume and timeout, and min and max endpointing delay.

`worker.py` turns the dict into objects, e.g. `TurnDetector(version="v1-mini")`.

**`sa_voice/agent.py`.** `CallAgent(Agent)` with `instructions=""` (the brain is the bridge) and `on_user_turn_completed(turn_ctx, new_message)`:
1. `speaker = router.floor_at_commit`;
2. `r = bridge.decide(seq, speaker, text)`;
3. if not `r.answer`, `raise StopResponse()`;
4. else stash `(seq, speaker, text)` for `BridgeLLM`.

After each reply, the `conversation_item_added` handler (or the 1.8.9 equivalent, verify) posts `bridge.spoken(seq, speaker, heard, said, timing)`, where `said` is what was played, truncated on interruption.

**`sa_voice/worker.py`:**
- **`main(argv)`:**
  - read the stdin config;
  - `os.environ.update(offline_env(...))`, popping the removed keys;
  - `redact.install()`;
  - build the livekit-agents worker with `agent_name="sa-voice"`, `ws_url=LIVEKIT_URL`, `api_key="sa-dev"`, `api_secret` from stdin, `prewarm` (load Silero), `request_fnc` and `entrypoint`;
  - run it in production (`start`) mode without reading our argv. If 1.8.9 only offers `cli.run_app`, set `sys.argv = ["sa-voice", "start"]` before calling it, and record which API was used;
  - after registration, `bridge.ready(os.getpid())`.
- **`request_fnc(req)`:** `va = json.loads(req.job.metadata)["voice_agent_id"]`, then `s = bridge.session(va)`. If `s.status != "active"` → `req.reject()`. Else `req.accept(identity=f"agent:{s.agent_id}", name=s.agent_name, attributes={"purpose": "voice", "voice_agent_id": va})`.
- **`entrypoint(ctx)`:**
  - fetch `secret`;
  - connect with auto-subscribe off and `rtc.E2EEOptions(key_provider_options=rtc.KeyProviderOptions(shared_key=key))` when a key is present (the parameter name per 1.8.9: `e2ee` or `encryption`);
  - wire the room events (`track_subscribed`, `track_muted`, `e2ee_state_changed`) to `E2eeWatchdog`. A reason → `bridge.report(va, "e2ee_failed", reason)` and disconnect;
  - start `AgentSession(**objects(session_kwargs(...)), vad=…, stt=ParakeetSTT, llm=BridgeLLM, tts=AudioApiTTS)` with `RoomAudio` as the audio input and the room's audio output publishing the agent's mic track, with text output and data publishing off;
  - call `POST /v1/audio/warmup` once;
  - `bridge.report(va, "joined")`;
  - on leave, report `left`;
  - an unhandled exception → `error` + `crashed`.
- **`download_files(argv)`:** runs livekit-agents' file download for the turn detector and Silero (the CLI `download-files` path of 1.8.9), with HF online. It is the only networked code path.

Tests (3, livekit-free unless skipped):
- `test_session_options.py`:
  1. `en` → detector `v1-mini`, mode `vad`;
  3. `offline_env` removes `LIVEKIT_DEV_MODE` and sets `HF_HUB_OFFLINE`.
- `test_stt_parakeet.py` (`importorskip`): against a local `websockets` fake server, an interim + final become INTERIM/FINAL events.

### T11: Web: voice agent in the call page

**`apps/web/src/call/api.ts`:** `inviteVoiceAgent(callId, {agent_id, language, media_key?})`, `voiceConsent(callId, decision)` and `stopVoiceAgent(callId)`.

**`TalkToAgent.tsx`:**
- One button per agent member of the chat, except the `scribe` template, labelled `Talk to <Name>`, with a language select (`English`, `Français`, `Deutsch`; default English).
- It is disabled with the title `<Name> is already in the call` while a voice agent is active.
- With `SA_CALL_E2EE` on, it sends the call's media key, the same as the notetaker invite.
- The error copy:
  - `voice_busy`: "Voices are busy on this Mac. Try again in a minute.";
  - `livekit_unavailable`: "Call audio is off: the call server is not running on this Mac.";
  - `voice_agent_disabled`: "Voice agents are off on this Mac.".

**`ConsentBanner.tsx`** gains a `subject: "notes" | "voice"` prop. The notes copy is unchanged. The voice copy is `<Name> is in this call and listens to answer questions. Let it hear you?` with the buttons `Let it hear me` / `Not me`.
- After "Not me": `<Name> can't hear you.` with `Change`.
- The inviter never sees the banner.

**`VoiceAgentPanel.tsx`:**
- An agent tile with the state:
  - `starting` → "Joining…";
  - `joined` → "Listening", or "Speaking" while LiveKit reports the `agent:<id>` participant speaking, with a pulsing ring;
  - `e2ee_failed` → "<Name> can't hear the call: the call key did not reach it.";
  - `error` / `failed` → "<Name> left the call: something went wrong on this Mac.".
- The hint "Say “<Name>, …” to ask." when more than one person is in the call, else "Just talk.".
- A `Stop <Name>` button for anyone in the call.
- `VoiceAgentHud.tsx` shows the last 5 `call.voice_turn` timings: `heard → spoke 0.84 s` (`first_audio_ms`, with `filler 0.9 s` when present). The popover holds the stages endpoint, STT, first token, first audio, filler and tools. Reuse `voice/LatencyHud.tsx` styles.

**`useVoiceAgent.ts`.** It holds the voice agent state from `call.updated` / `call.voice_turn` and the speaking state from LiveKit. **Interruption feel:** while the local participant is speaking and the agent is speaking, it sets the agent's `RemoteAudioTrack` volume to 0.3 at once, and back to 1.0 600 ms after either stops. Add `setRemoteVolume(identity, v)` and `onSpeaking(identity, cb)` to `media.ts`.

**`CallPage.tsx`** mounts the button, banner, panel and HUD. With `?talk=<agentId>` in the URL, it invites that agent once, right after joining, when the media key is known, then removes the param.

**`useCall.ts`** routes `call.voice_turn` to `useVoiceAgent`.

Tests:
- `apps/web/test/call-voice-panel.test.tsx` (4): the state labels; the group/1:1 hint; Stop visible to a non-inviter; `?talk=` invites once.
- `apps/web/test/call-voice-consent.test.tsx` (2): the voice banner copy and decisions; the inviter sees no banner.
- `apps/web/test/call-voice-duck.test.ts` (1): volume 0.3 while both speak, and 1.0 600 ms later (fake timers).

### T12: Web: "Talk to <agent>" in an agent DM

**`ChannelHeader.tsx`:**
- In a DM whose other member is an agent (not `scribe`), add a `Talk to <Name>` button next to `Start call`.
- It runs the existing start-call flow (`POST /api/chats/:id/calls`, plus the media key message and anchor, exactly as `startCall` does), then navigates to `/c/<chatId>/call/<callId>?talk=<agentId>`.
- When a call is already active in the DM, it navigates to it with `?talk=`.

**`apps/web/src/lib/bridge-events.ts`:** make sure `call.voice_turn` is dispatched like the other `call.*` events. If it already dispatches by type, there is no change, and the ledger says so.

`apps/web/test/agent-dm-talk.test.tsx` (2): the button shows only in an agent DM; the click starts the call and navigates with `?talk=`.

### T13: E2E offline: talk to an agent with a fake worker

`e2e/start-bridge.sh` exports `SA_VOICE_AGENT=fake`. The echo brain comes from T7 (with `SA_VOICE_AGENT=fake`, `/turn` streams `You said: <text>` in 3 deltas, then `done`, with no LLM). If it is missing, report BLOCKED against T7 instead of adding it here.

**`e2e/tests/call-voice.spec.ts`** (4), with the internal calls made by Playwright `request` using `MEETING_TOKEN` from the e2e env:
1. Ana in her DM with Ops clicks `Talk to Ops`. The call page shows the Ops tile "Joining…" (fake → "Listening" after `POST /internal/voice/:id/worker {state:"joined"}`), and a `spoken` post shows `heard → spoke` in the HUD.
2. A group channel with Ana and Ben, Ana invites Ops: Ben sees the voice banner, clicks `Not me`, and `decide` with `speaker: user:<ben>` returns `not_consented`.
3. Ben clicks `Stop Ops`, the tile disappears for both, and the receipt `Left the call · answered once` is in the call thread.
4. `call.voice_turn` does not reach a chat member who is not in the call.

### T14: Live: offline run, measurements, E2EE checks, tuning (alone)

Preconditions: `livekit-server` is installed (else BLOCKED, see Global Constraints) and `make models` has been run (incl. T1's new models). Close other apps and record the swap before starting.

1. Run `make up`, then `make livekit`, then `make dev` with `SA_VOICE_AGENT=worker`. E2EE is off, the default, and the sandbox is on by default.
2. Run `make voice-calibrate`. If the calibration gate fails, fix the harness first (T4/T4b files, recorded in the ledger) before any agent number counts.
3. Run `make voice-bench`, all scenarios except `e2ee`. Then restart `make dev` with `SA_CALL_E2EE=1` and run `SCENARIOS=e2ee` once: 10 utterances with the call's key, plus one wrong key. This is a join check only; there is no on/off cost gate.
4. **Offline proof:** check that the worker is running under `sandbox-exec` (`ps -o command= -p $(cat .run/voice-worker.pid)`) and that the egress scan shows 0 non-loopback connections. Run the bench once more with Wi-Fi off, if the human agrees; otherwise state "sandbox + scan only".
5. **Tuning:** if a latency or barge-in gate fails, change at most one knob per run, inside these ranges, and keep it only if the target metric improves by ≥ 10 % and no other gate gets worse:
   - `turn.min_endpointing_delay` 0.2–0.6;
   - `clauses.first_min_words` 3–6;
   - `filler.after_ms` 800–1500;
   - `interruption.min_duration` 0.3–0.8;
   - `interruption.min_words` 0–2;
   - `vad.min_silence_duration` 0.25–0.5.
   
   Record every A/B in the doc.
6. Write `docs/perf/2026-10-26-call-voice-agent.md`:
   - `## Call voice agent: results` with the setup (git SHA, model, profile, E2EE, sandbox, fixture source tts/human) and the report tables from T4;
   - the per-stage breakdown (p50 of `endpoint_ms`, `stt_ms`, `first_token_ms`, `first_audio_ms`);
   - the tuning table;
   - the memory and swap measurements against the budget;
   - a "Follow-ups" list: Kokoro CoreML if `load_p50_degradation` > 20 %; the Parakeet EOU (en) model if endpointing dominates.
   
   Write the kept values to `config/voice-agent.tuned.yaml` (only the changed keys, with a comment per key naming the A/B row), and leave `config/voice-agent.yaml` alone. No transcript text in the doc.

### T15: Spike: VoiceChat INT5 under 9B load, 1 day, isolated (alone, last)

Isolated from product code: a new folder `spikes/voicechat-int5/` with its own `pyproject.toml` (not a workspace member, its own `uv.lock`). It imports nothing from `services/*`, and nothing in `services/*` imports it.

1. **Licence first.** Read the `LICENSE` file of `nvidia/NVIDIA-NemotronLabs-VoiceChat-11B` and the card of the MLX INT5 conversion (`aufklarer/VoiceChat-11B-Perception-MLX-int5`), with `hf` / the HF API. Record the licence (expected OpenMDW 1.1) and whether "research-only" appears anywhere. A licence that is not usable commercially is recorded as a blocker for phase 2, and the performance run still happens.
2. **Runtime.** Use `mlx-audio` (`pyproject` dep in the spike only) if its installed version has VoiceChat support. Else use `speech-swift` built with `swift build -c release`, if a Swift toolchain exists (`swift --version`). If neither works → BLOCKED with "VoiceChat needs a Swift toolchain (human step)".
3. **Weights** (~8.6 GB) through `spikes/voicechat-int5/download.sh` (`hf download …`). `spike.py --cleanup` (the default) deletes them from the HF cache at the end, and `--keep` keeps them.
4. **Run.** Stop the product stack except the LLM (`make down`, then start only the LLM with `infra/models/start-llm.sh fast`).
   - Feed 10 minutes of input at real time in 80 ms frames: T4-style fixtures generated earlier (copied WAVs, not imported code) separated by silence.
   - Run the 9B decode loop concurrently: a copy of T4's `load.py` logic in `spikes/voicechat-int5/load9b.py`, 512-token completions with thinking off.
   - Record per-frame compute ms, every degradation the runtime reports (TTS refinement steps below 8, dropped input frames), the footprint (RSS) every 5 s, the swap and the 9B tok/s.
   - Also run 2 minutes without the 9B as a reference.
5. **Gate:** per-frame p95 ≤ 72 ms while the 9B decodes, for the full 10 min on the M4 Max, with zero degradation events.
6. Write `docs/perf/2026-10-27-voicechat-int5-spike.md`:
   - the first line is `Verdict: GO` or `Verdict: NO-GO`;
   - then the licence, the runtime, the p50/p95/p99 per frame with and without load, degradations, memory/swap, 9B tok/s under load, and English-only + tool-calling caveats from the research.
   
   **NO-GO closes the native direction** for this hardware and model generation, and the doc lists the research's re-evaluation triggers: open Dessa weights, a Moshi successor, a multilingual VoiceChat, a favourable contention measurement. **GO** lists the next steps: a licence check by the owner, then a `DuplexModel` plugin with a single `delegate_to_agent` tool, written as a separate plan.

```relay-plan
{
  "slug": "sa-voice-agent-calls",
  "suite": "make check",
  "setup": "pnpm install --frozen-lockfile && uv sync",
  "tasks": [
    {"id": "T1", "title": "Dependencies, package skeleton, models, licences, sandbox profile, Make targets", "tier": "mid", "code": "prose", "risk": "medium", "files": ["pyproject.toml", "uv.lock", "services/voice-agent/pyproject.toml", "services/voice-agent/src/sa_voice/__init__.py", "services/voice-agent/src/sa_voice/main.py", "services/voice-agent/tests/test_cli.py", "services/audio-api/pyproject.toml", "config/models.yaml", "infra/models/download.sh", "infra/models/README.md", "infra/voice/offline.sb", "Makefile", ".env.example", "docs/voice/models.md", "docs/superpowers/specs/decisions.md"], "deps": [], "behaviors": ["sa-voice CLI dispatches six lazy subcommands", "make models downloads Parakeet v3 and the v1-mini turn detector", "the sandbox profile denies non-loopback network", "every speech component has a recorded licence, languages and EC2 Mac portability"], "tests": 1, "done": "uv sync && uv run python -c 'import sa_voice' && uv run pytest services/voice-agent/tests/test_cli.py && bash -n infra/models/download.sh && make -n voice-bench"},
    {"id": "T2", "title": "Protocol types and migration 008", "tier": "cheap", "code": "complete", "risk": "medium", "files": ["packages/protocol/src/index.ts", "packages/protocol/test/call-voice.test.ts", "services/bridge/src/migrations/008_call_voice.sql"], "deps": [], "behaviors": ["CallInfo carries the call's voice agent", "worker-bridge contract types parse and reject bad speakers", "call.voice_turn is a server event", "voice languages are en, fr and de only"], "tests": 3, "done": "pnpm --filter @sa/protocol test && pnpm --filter @sa/protocol typecheck"},
    {"id": "T3", "title": "audio-api: streaming Parakeet, raw-PCM TTS, one MLX lock", "tier": "mid", "code": "prose", "risk": "medium", "files": ["services/audio-api/src/sa_audio/mlx_lock.py", "services/audio-api/src/sa_audio/parakeet.py", "services/audio-api/src/sa_audio/stream.py", "services/audio-api/src/sa_audio/app.py", "services/audio-api/src/sa_audio/tts.py", "services/audio-api/src/sa_audio/main.py", "services/audio-api/tests/test_stt_stream.py", "services/audio-api/tests/test_speech_pcm.py"], "deps": ["T1"], "behaviors": ["the STT WebSocket refuses a wrong token", "interim transcripts at most every 300 ms", "flush returns a final and starts a fresh stream", "no streaming engine closes with 4503", "PCM speech streams raw s16le with its rate header", "over-long speech text is rejected"], "tests": 6, "done": "uv run ruff check services/audio-api && uv run pytest services/audio-api/tests/test_stt_stream.py services/audio-api/tests/test_speech_pcm.py"},
    {"id": "T4", "title": "Bench harness core (Python): T0/T1, scenarios, stats, report, calibration bot, load", "tier": "mid", "code": "prose", "risk": "medium", "files": ["services/voice-agent/src/sa_voice/bench/__init__.py", "services/voice-agent/src/sa_voice/bench/signal.py", "services/voice-agent/src/sa_voice/bench/stats.py", "services/voice-agent/src/sa_voice/bench/fixtures.py", "services/voice-agent/src/sa_voice/bench/participant.py", "services/voice-agent/src/sa_voice/bench/calibrate.py", "services/voice-agent/src/sa_voice/bench/load.py", "services/voice-agent/src/sa_voice/bench/report.py", "services/voice-agent/tests/test_bench_signal.py", "services/voice-agent/tests/test_bench_stats.py", "services/voice-agent/tests/test_bench_report.py"], "deps": ["T1"], "behaviors": ["T0 is the end of the last word from the file", "T1 is the first non-silent received frame, ignoring clicks", "p50/p95 are nearest rank", "the report marks each gate PASS, FAIL or not run"], "tests": 4, "done": "uv run ruff check services/voice-agent && uv run pytest services/voice-agent/tests/test_bench_signal.py services/voice-agent/tests/test_bench_stats.py services/voice-agent/tests/test_bench_report.py"},
    {"id": "T4b", "title": "Bench orchestrator (TypeScript)", "tier": "mid", "code": "prose", "risk": "low", "files": ["e2e/live/voice-agent-bench.ts", "e2e/live/voice-agent-lib.ts"], "deps": ["T2", "T4"], "behaviors": ["one command runs calibration or every scenario and prints the report"], "tests": 0, "done": "pnpm --filter @sa/e2e exec tsc --noEmit -p ."},
    {"id": "T5", "title": "MCP catalog: one tool list and one run path for MCP and voice (test-author first)", "tier": "mid", "code": "prose", "risk": "high", "files": ["services/bridge/src/mcp/catalog.ts", "services/bridge/src/mcp/server.ts", "services/bridge/test/mcp-catalog.test.ts"], "deps": [], "behaviors": ["voice and MCP list the same tools per agent", "unknown and failing tools return errors", "direct runs carry the requester and chat", "direct runs never touch a running turn's ToolLog", "results serialise exactly as MCP does"], "tests": 5, "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/mcp-catalog.test.ts test/mcp.test.ts"},
    {"id": "T6", "title": "Bridge voice sessions: store, rules, public routes, plugin (test-author first)", "tier": "mid", "code": "prose", "risk": "high", "files": ["services/bridge/src/calls/voice-rules.ts", "services/bridge/src/calls/voice-store.ts", "services/bridge/src/calls/voice-session.ts", "services/bridge/src/calls/voice-routes.ts", "services/bridge/src/calls/store.ts", "services/bridge/src/plugins/call-voice.ts", "services/bridge/test/call-voice-rules.test.ts", "services/bridge/test/call-voice-scope.test.ts", "services/bridge/test/call-voice-routes.test.ts"], "deps": ["T2"], "behaviors": ["answers everything when one human is in the call", "answers a group utterance that names the agent at the start or end", "dotted STT spellings of the name still match", "a follow-up from the same person within 10 s is answered", "a non-consenting speaker is never answered", "one voice agent per call and a global session limit", "only call participants can invite", "anyone in the call can stop the agent", "a receipt without text is posted after answers", "a 1:1 call gets the speaker's DM access, taught knowledge included", "a group call follows the chat's share rule: with ask, nothing taught is spoken", "the follow-up window ends exactly at 10 s", "a speaker without a DM falls back to group rules", "a second invite while one is active is refused", "the scribe agent cannot be a voice agent", "non-participants cannot invite"], "tests": 16, "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/call-voice-rules.test.ts test/call-voice-scope.test.ts test/call-voice-routes.test.ts"},
    {"id": "T7", "title": "Bridge internal voice routes, worker supervisor, perf readout (test-author first)", "tier": "strong", "code": "prose", "risk": "high", "files": ["services/bridge/src/calls/voice-internal.ts", "services/bridge/src/calls/voice-worker.ts", "services/bridge/src/plugins/call-voice.ts", "services/bridge/test/call-voice-internal.test.ts", "services/bridge/test/call-voice-worker.test.ts"], "deps": ["T6", "T8"], "behaviors": ["internal routes are loopback and token only", "the media key is served only while active", "a declined speaker's turn is refused", "a new turn aborts the running one", "a closed stream aborts the running turn", "turn timings reach only people in the call, with no text", "E2EE failure fails the session and drops history", "fake mode streams an echo answer without an LLM", "the worker runs sandboxed with secrets on stdin", "worker readiness times out and respawns are bounded", "a worker exit fails active sessions", "each turn's knowledge scope is recomputed from who is in the call"], "tests": 11, "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/call-voice-internal.test.ts test/call-voice-worker.test.ts"},
    {"id": "T8", "title": "The brain: direct call turn with tools (test-author first)", "tier": "strong", "code": "prose", "risk": "high", "files": ["services/bridge/src/agents/call-turn-llm.ts", "services/bridge/src/agents/call-turn.ts", "services/bridge/test/call-turn-llm.test.ts", "services/bridge/test/call-turn.test.ts"], "deps": ["T2", "T5"], "behaviors": ["voice turns run the 9B with thinking off and short answers", "tool calls stream start/end events and feed results back", "tool-call fragments are assembled across chunks", "think text is never emitted", "the speaker is the tool requester and the R8 scope sets the chat and taught knowledge", "the last round forbids tools", "abort stops further tools at once", "round and turn timeouts end the turn with an error", "LLM errors end the turn with llm_failed", "voice turns never touch the text turn hooks", "group calls with sharing=ask offer to post in the chat instead of speaking taught knowledge", "round 4 sends tool_choice none"], "tests": 12, "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/call-turn-llm.test.ts test/call-turn.test.ts"},
    {"id": "T9", "title": "Voice worker pure modules: config, clauses, filler, floor, watchdog, bridge client, redaction", "tier": "mid", "code": "prose", "risk": "high", "files": ["config/voice-agent.yaml", "services/voice-agent/src/sa_voice/config.py", "services/voice-agent/src/sa_voice/clauses.py", "services/voice-agent/src/sa_voice/filler.py", "services/voice-agent/src/sa_voice/floor.py", "services/voice-agent/src/sa_voice/watchdog.py", "services/voice-agent/src/sa_voice/bridge_client.py", "services/voice-agent/src/sa_voice/redact.py", "services/voice-agent/tests/test_clauses.py", "services/voice-agent/tests/test_filler.py", "services/voice-agent/tests/test_floor.py", "services/voice-agent/tests/test_watchdog.py", "services/voice-agent/tests/test_bridge_client.py", "services/voice-agent/tests/test_redact.py", "services/voice-agent/tests/test_config.py"], "deps": ["T1"], "behaviors": ["the first clause is spoken before the sentence ends", "long unpunctuated text is cut at the word limit", "markdown never reaches TTS", "fillers come on a timer or at tool start, spaced and capped", "progress lines play while a tool runs long and stop once the answer starts", "only consenting people are subscribed", "withdrawing consent drops the person's turn", "a single participant holds the floor; the floor waits for a pending turn", "another speaker interrupts the agent", "silent E2EE failure is detected, muted tracks are not", "the worker refuses non-loopback audio and bridge URLs", "the tuned overlay only overrides known keys", "closing a turn stream closes the HTTP response", "nothing heard reaches the logs", "a clause below the word minimum waits for the sentence end", "flush speaks the remainder", "the filler gap and per-turn cap hold", "no filler after answer text starts", "the floor is released after the holder's silence", "an interrupt fires once per agent speech", "no frames for 5 s fails an E2EE session", "turn NDJSON lines parse into events"], "tests": 22, "done": "uv run ruff check services/voice-agent && uv run pytest services/voice-agent/tests/test_clauses.py services/voice-agent/tests/test_filler.py services/voice-agent/tests/test_floor.py services/voice-agent/tests/test_watchdog.py services/voice-agent/tests/test_bridge_client.py services/voice-agent/tests/test_redact.py services/voice-agent/tests/test_config.py"},
    {"id": "T10", "title": "Voice worker on livekit-agents: STT, TTS, bridge LLM, audio input, session, E2EE", "tier": "strong", "code": "prose", "risk": "high", "files": ["services/voice-agent/src/sa_voice/stt_parakeet.py", "services/voice-agent/src/sa_voice/tts_audio_api.py", "services/voice-agent/src/sa_voice/bridge_llm.py", "services/voice-agent/src/sa_voice/audio_input.py", "services/voice-agent/src/sa_voice/session_options.py", "services/voice-agent/src/sa_voice/agent.py", "services/voice-agent/src/sa_voice/worker.py", "services/voice-agent/tests/test_session_options.py", "services/voice-agent/tests/test_stt_parakeet.py"], "deps": ["T3", "T9"], "behaviors": ["turn detection is the local v1-mini for en, fr and de", "interruption mode is vad with no cloud keys in the env", "streaming STT emits interim and final transcripts"], "tests": 3, "done": "uv run ruff check services/voice-agent && uv run pytest services/voice-agent/tests/test_session_options.py services/voice-agent/tests/test_stt_parakeet.py"},
    {"id": "T11", "title": "Web: voice agent in the call page", "tier": "mid", "code": "prose", "risk": "medium", "files": ["apps/web/src/call/api.ts", "apps/web/src/call/TalkToAgent.tsx", "apps/web/src/call/ConsentBanner.tsx", "apps/web/src/call/VoiceAgentPanel.tsx", "apps/web/src/call/VoiceAgentHud.tsx", "apps/web/src/call/useVoiceAgent.ts", "apps/web/src/call/media.ts", "apps/web/src/call/CallPage.tsx", "apps/web/src/call/useCall.ts", "apps/web/test/call-voice-panel.test.tsx", "apps/web/test/call-voice-consent.test.tsx", "apps/web/test/call-voice-duck.test.ts"], "deps": ["T2"], "behaviors": ["Talk to <agent> invites with the chosen language (en, fr, de)", "the agent tile shows joining, listening, speaking and failure states", "non-inviters get the voice consent banner; the inviter does not", "anyone can stop the agent", "the agent's audio ducks at once when the user talks over it", "the HUD shows heard-to-spoke latency per turn", "?talk= invites the agent once after joining"], "tests": 7, "done": "pnpm --filter @sa/web typecheck && pnpm --filter @sa/web exec vitest run test/call-voice-panel.test.tsx test/call-voice-consent.test.tsx test/call-voice-duck.test.ts"},
    {"id": "T12", "title": "Web: Talk to <agent> in an agent DM", "tier": "mid", "code": "prose", "risk": "medium", "files": ["apps/web/src/channel/ChannelHeader.tsx", "apps/web/src/lib/bridge-events.ts", "apps/web/test/agent-dm-talk.test.tsx"], "deps": ["T11"], "behaviors": ["an agent DM offers Talk to <agent> and opens the call with the agent invited", "an active DM call is reused"], "tests": 2, "done": "pnpm --filter @sa/web typecheck && pnpm --filter @sa/web exec vitest run test/agent-dm-talk.test.tsx"},
    {"id": "T13", "title": "E2E offline: talk to an agent with a fake worker", "tier": "mid", "code": "prose", "risk": "medium", "files": ["e2e/start-bridge.sh", "e2e/tests/call-voice.spec.ts"], "deps": ["T7", "T11", "T12"], "behaviors": ["DM talk flow shows the agent and latency", "a decliner is never answered", "stop removes the agent for everyone with a receipt", "turn timings stay inside the call"], "tests": 4, "done": "pnpm --filter @sa/e2e exec playwright test tests/call-voice.spec.ts"},
    {"id": "T14", "title": "Live: offline run, measurements, E2EE checks, tuning (alone)", "tier": "mid", "code": "prose", "risk": "medium", "files": ["docs/perf/2026-10-26-call-voice-agent.md", "config/voice-agent.tuned.yaml"], "deps": ["T4b", "T7", "T10", "T13"], "behaviors": ["mouth-to-ear p50/p95 with and without 9B load, per language", "tool turn filler and answer times", "barge-in reaction and false interruptions", "joining an E2EE call and an explicit wrong-key failure", "resources and a sandboxed offline run"], "tests": 0, "done": "test -s docs/perf/2026-10-26-call-voice-agent.md && grep -q '^## Call voice agent: results' docs/perf/2026-10-26-call-voice-agent.md"},
    {"id": "T15", "title": "Spike: VoiceChat INT5 under 9B load, 1 day, isolated (alone, last)", "tier": "strong", "code": "prose", "risk": "low", "files": ["spikes/voicechat-int5/pyproject.toml", "spikes/voicechat-int5/uv.lock", "spikes/voicechat-int5/README.md", "spikes/voicechat-int5/download.sh", "spikes/voicechat-int5/spike.py", "spikes/voicechat-int5/load9b.py", "docs/perf/2026-10-27-voicechat-int5-spike.md"], "deps": ["T14"], "behaviors": ["a GO/NO-GO verdict on per-frame p95 <= 72 ms while the 9B decodes for 10 minutes"], "tests": 0, "done": "head -1 docs/perf/2026-10-27-voicechat-int5-spike.md | grep -Eq '^Verdict: (GO|NO-GO)$'"}
  ]
}
```
