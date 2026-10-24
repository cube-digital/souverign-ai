# Voice and Meetings Plan

**Goal:** people talk to agents with push-to-talk and hear them answer, and any chat can start a local call where a notetaker (Scribe) transcribes only the people who consent. Its notes stay private to the person who invited it until that person approves them. Then they go to the call's thread and into the chat's memory, and @Scribe can answer "what did we decide in the call?".
**Spec:** `.handoff/plans/remaining-plans.md` P3 + P4, `docs/superpowers/specs/decisions.md` D-2/D-3/D-4/D-9, `docs/superpowers/specs/2026-10-24-sovereign-agents-demo-design.md` §8.2/§8.5–§8.7/SP5/SP6, `.handoff/reports/AI teammates in team chat.md` (meeting notes, consent, who sees summaries). Mockups: `docs/design/mockups/Call.dc.html`, `Main.dc.html` (PTT + "voice to voice 1.8 s").
**Runs after:** T1 agent teammates (`docs/relay/plans/2026-10-24-agent-teammates.md`), the memory + approvals plan (`docs/relay/plans/2026-10-25-memory-approvals.md`) and the Google login plan (migration 005, `sa.identities`, not used here). This plan's migration is `006_calls.sql`, and it binds to the memory + approvals plan's "For later plans (stable seams)" names.
**Architecture:** a voice message is an ordinary encrypted file message with `voice` metadata. The bridge-hosted agent device decrypts it, transcribes it through audio-api (:8645) and runs the normal T1 turn on the transcript. The reply text is split into sentences, and each one is spoken by audio-api TTS and streamed to the requester over SSE. The joined audio is then posted as an encrypted voice reply, with a latency receipt in the reply's `meta`.

Calls are LiveKit rooms (`call-<id>`), one per chat at a time, with tokens minted by the bridge plugin `plugins/calls.ts`. Consent, the live transcript and notes all travel over the bridge (SSE), not LiveKit, so the whole flow works and is testable without a call server. The notetaker is a Python worker (`services/meeting-agent`) that the bridge spawns per call. It joins as `agent:<scribe id>` with publish rights off (D-4), subscribes only to the audio of participants who accepted, cuts per-speaker VAD segments, transcribes them locally and posts them to the bridge. The bridge summarises through Scribe's runtime every 5 minutes and at the end. The final notes become a gated `call_notes_publish` approval for the inviter, and approving it posts them in the call thread and ingests them as memory `kind=meeting`.

## Decisions

- **Notetaker = the workspace agent Scribe** (`sa.agents` with `scope='workspace'`, `roster_id='scribe'`). Any participant can invite it, and that person is the **inviter**: the D-3 "owner" of those notes, because Scribe has no owner. Scribe must be an active member of the chat. If it is not, the web first adds it with the T1 workspace-agent flow (epoch claim + key rotation + join line), then invites it.
- **Consent is per person, and decliners are never captured.** The inviter is recorded as `accepted` at invite time. Every other participant sees the banner and answers Accept or Decline. Silence counts as not captured. The worker subscribes only to tracks of participants whose current decision is `accepted` and who are in the call, re-checking every 2 s. The bridge also rejects segments from any other speaker (`403 not_consented`). A person can change their answer at any time, and a change takes effect for the next segment. The posted notes name only the captured speakers and say `Not captured: N people who did not consent` (no names). Interpretation: "declined attendees are excluded" means their voice is never transcribed, summarised or stored. They still see the posted notes like every chat member. (Human decision 1.)
- **Anyone in the call can stop the notes, immediately.** `POST /api/calls/:id/notetaker/stop` sets `status='stopped'`, records `stopped_by`, makes the worker leave within 2 s and triggers the final summary of what was captured before the stop. This is stricter than the mockup's "the call owner decides". (Human decision 2.)
- **D-3 visibility.** The live capture lines ("What Scribe is capturing") are shown to everyone currently in the call, as in the mockup. Interim and final notes, the approval card and `GET /api/calls/:id/notes` go to the inviter only. Nothing reaches the chat or memory before the inviter approves, and on deny or expiry nothing is posted or ingested. After approval, the notes and action items can be read in the call's chat. The verbatim transcript stays with the inviter, readable only in the inviter's DM with Scribe (`meeting_transcript`).
- **Approval** (memory + approvals seams). At init, `plugins/calls.ts` calls `registerGatedTool("call_notes_publish", {executor, approverRule, defaultTtlMs: 24 * 60 * 60 * 1000})`, so these approvals last 24 h instead of the 12 h default (human decision 3). `approverRule` returns the inviter of `args.notes_id`.
  - The final notes call `requestApproval({agentId: <Scribe>, chatId: <inviter's DM with Scribe>, replyTo: null, turnId: null, requesterUserId: <inviter>, kind: "tool", tool: "call_notes_publish", args: {chat_id, call_id, notes_id, text}, ttlMs: 24 * 60 * 60 * 1000})`.
  - The approval's chat is the inviter's DM with Scribe (created through T1's agent-DM path when missing), so `approval_public` never shows in the call's chat.
  - The executor:
    - `editable: ["text"]`, `alwaysAllowed: false`, `stamp: false`.
    - `validate` re-checks that the notes exist, belong to `call_id` and are `pending_approval`, and that `text` is 1–7900 chars (`ArgsError` otherwise).
    - `preview` = title `Post call notes in #<chat>`, target `#<chat> · call thread`, one field holding the text, `leaves_chat: true`. The web `ApprovalCard` renders it generically.
    - `execute` follows "Summaries reach people" below.
    - `onDenied` and the expiry sweep mark the notes `not_published`.
- **Summaries reach people.** On approve, `execute` re-checks that Scribe is still an active member of the call's chat (else it throws `notetaker_not_in_chat`), then:
  1. Posts as Scribe (`ctx.agentHost.sendAs`) in the call's chat with `reply_to = anchor_message_id` (top-level without one) and `meta.meeting = {call_id, action_items}`. The action items are re-parsed from the approved text.
  2. Ingests via `memory()?.ingest({namespace: "chat:<chat_id>", kind: "meeting", source: {type: "meeting", id: call_id, title: "Call notes <date>", ts: started_at}, text})`. `SourceType` is `meeting`, so recall citations read "Call notes <date>". A failed or missing ingest does not unpublish, and the result says `memory failed`.
  3. Publishes `call.notes_published {call_id, chat_id, message_id, title}` to every active human member of the chat. The web counts it as an unread mention on that chat and shows the toast `Notes from <title> are ready` linking to the thread. `title` = `<chat title> call · <en-GB date, time>`.
  4. Returns `Posted call notes in #<chat>`.
  - **Reminder.** A 60 s sweep in `plugins/calls.ts` finds notes still `pending_approval` 20 h after the approval was requested with `reminded_at is null`.
    - Scribe DMs the inviter "Your notes from the call in #<chat> (<date>) are still waiting for your approval. They expire in 4 hours." with `meta.call_notes = {call_id, notes_id, state: "pending"}`, which the web renders as `Review notes`.
    - The sweep then sets `reminded_at`, so the reminder goes out at most once per approval round, even across restarts.
  - **Publish notes again.** When notes become `not_published` (denied, expired, or `requestApproval` returning an error), Scribe DMs the inviter "The notes from the call in #<chat> were not published." with `meta.call_notes = {…, state: "not_published"}`.
    - Expiry is detected by the sweep reading the approval's status. Every transition is guarded by `update … where status = 'pending_approval' returning`, so the DM goes out once.
    - The web renders a `Publish notes again` button that calls `POST /api/calls/notes/:notesId/republish`. It works for the inviter only, only from `not_published`, and within 7 days of the call.
    - It runs a new `requestApproval` with the same text and a fresh 24 h TTL, sets the notes back to `pending_approval` and clears `reminded_at`.
- **Notes format.** The bridge writes a deterministic header (`**Call notes** · <chat> · <date> · <N> min`, `Speakers: …`, the not-captured count, `Draft by Scribe on this Mac.`). The model writes four sections: `## Summary`, `## Decisions`, `## Action items` (`- [ ] Owner: task (due: when)`) and `## Open questions`. Action items are parsed from the `## Action items` section (≤ 30). Transcripts over 14 000 chars are summarised in 12 000-char parts that are then merged. If the model fails, the bridge still produces notes: the header plus "The summary could not be generated on this Mac" and the last 40 transcript lines. It never stays silent. The total is ≤ 7500 chars.
- **Summaries run through the agent runtime:** `AgentHostApi.complete(agentId, "call-notes:<notetakerId>", messages)`. That is `runtime.chat` on the shared T1 turn queue in the proactive class, with `forceFirstTool` off for the call and a 180 s timeout. Interim summaries run every `SA_NOTES_INTERVAL_MS` (default 300 000) when new segments have arrived since the last version. The final one runs exactly once, when the notetaker leaves `active` (stop, call end, worker failure). At most one summary runs per notetaker at a time, and the final waits for an in-flight interim.
- **Call lifecycle.** `POST /api/chats/:id/calls` creates the call, or returns the active one (partial unique index). The starter's browser generates a 32-byte media key and sends an encrypted text "<Name> started a call." with `meta.call = {call_id, op:"started", media_key}`. It reports that message id with `POST /api/calls/:id/anchor`, and the anchor is the call's thread root. Joining = `POST /api/calls/:id/token`, which marks the user in the call. Leaving = `POST /api/calls/:id/leave` (also sent with `sendBeacon` on `pagehide`). LiveKit webhooks (`participant_joined`/`participant_left`/`room_finished`) keep presence right when the server runs. The call ends on `POST /end` (starter or chat owner) or 30 s after the last human leaves. The starter's browser then posts `meta.call = {op:"ended", duration_ms}` in the thread when it is still open; otherwise the card reads the end from `GET /api/calls/:id`.
- **Tokens** (`livekit-server-sdk` `AccessToken`, TTL 2 h, room `call-<id>`). Users: identity `user:<id>`, name = display name, `canPublish: true`, `canPublishSources: [MICROPHONE]`, `canSubscribe: true`, `canPublishData: false`. Notetaker: identity `agent:<agentId>`, name `Scribe · taking notes`, metadata `{"purpose":"notes","invited_by":"<name>"}`, `canPublish: false`, `canPublishData: false`, `canSubscribe: true`, `hidden: false` (everyone sees it in the room).
- **No call server = still testable.** `POST /token` returns `{available:false}` when `LIVEKIT_URL` does not answer HTTP within 1 s (cached 5 s). The page then shows "Call audio is off: the call server is not running on this Mac. Consent and notes still work." `SA_NOTETAKER=worker|fake|off` (default `worker`). `fake` spawns nothing and marks the worker `fake`, which e2e uses and then posts segments itself. `off` → `503 notetaker_disabled`. In `worker` mode, an invite while LiveKit is down → `503 livekit_unavailable`.
- **Media E2EE is built but off.** The SFU must see only ciphertext in the target architecture. With `SA_CALL_E2EE=1`, browsers enable LiveKit E2EE (`ExternalE2EEKeyProvider`) with the media key from the encrypted `meta.call`. The inviter's browser hands the key to the bridge with the invite, the bridge keeps it in memory only, and the worker receives it on stdin (`rtc.E2EEOptions`). The default is `0` until `make call-smoke` has passed with LiveKit installed (human decision 4). The trust line says "Call server runs on this Mac" either way, and with E2EE off it adds "audio is encrypted to this Mac, not end to end yet".
- **Worker process.** The bridge spawns `uv run --project <repo root> --no-sync sa-meeting join` with env `SA_BRIDGE_URL`, `SA_NOTETAKER_ID`, `LIVEKIT_URL`, `AUDIO_URL`, `SA_STT_LANGUAGE` (default `en`, D-2). Secrets go as one JSON line on stdin: `{"lk_token":…, "meeting_token":…, "audio_token":…, "media_key":…|null}`. Pid files live in `.run/notetakers/<id>.pid`, and plugin init kills leftovers. Exit ≠ 0 while `active` → `status='failed'`, `worker='error'` → final summary. Speech detection: Silero (`livekit-plugins-silero`) live, `EnergySegmenter` in tests. Segments < 0.6 s are dropped and > 20 s are cut, with a 200 ms pre-roll. STT runs one request at a time (audio-api `/v1/audio/transcriptions`, 16 kHz mono WAV). Empty or hallucinated texts (`[BLANK_AUDIO]`, `Thank you.`, `you`, `.`) are dropped.
- **Voice messages.** The web records Opus/WebM (`audio/mp4` on Safari) by holding the mic button: ≤ 60 s (auto-stop), < 0.5 s discarded ("Too short"), Esc or pointer-leave cancels. It sends `engine.sendFile(chat, {name:"voice-<ts>.webm", mime, bytes}, {voice:{duration_ms}, replyTo})`. whisper-server runs with `--convert`, so WebM goes to STT as is.
- **Which voice messages an agent answers.** Agent devices never trigger. The host transcribes a voice message at most once (dedupe by message id across all agent devices, kept 10 min). It answers when T1's rules match: a DM with that agent, or a follow-up in a thread the agent owns. In groups it also answers when the transcript starts by addressing the agent (`^\W*(?:hey|hi|ok|okay)?[\s,]*@?<name>\b`, case-insensitive). If none match, nothing is posted and the transcript is dropped.
- **Voice reply.** In order: (1) the transcript as text with `meta.transcript_of = <voice msg id>` and the same `reply_to`; the UI shows it under the voice bubble as "Transcript · on this Mac" and hides it from the list. (2) The normal T1 turn on the transcript, with `onDelta` feeding a sentence splitter. Each sentence (markdown stripped, at most 600 spoken chars per reply) goes to TTS in order, and each WAV is sent as SSE `voice.chunk` to the requester only. (3) The concatenated WAV as a voice file reply (`voice.duration_ms`, same thread). (4) The reply text with `meta.audio_id = <file id>` and `meta.latency`. The UI renders the player inside the agent reply and hides the referenced file message. TTS language = the STT language when it is in `en|fr|es|it|de|ro`, else `en` (D-2: Kokoro en/fr/es/it, Piper de/ro). A stopped turn sends no audio. An STT failure → reply "I couldn't transcribe that voice message." A TTS failure → text reply only, without `first_audio_ms`.
- **Latency.** `meta.latency = {stt_ms, first_token_ms?, first_audio_ms?, total_ms}`, measured from when the bridge received the envelope. It is sent to the requester as SSE `latency.sample`. The web's "voice to voice" = PTT release → first `voice.chunk` played (client clock), shown as `voice to voice 1.8 s` with a stage popover. The < 2000 ms target on `fast` is reported by the live task, never gated.
- **`meeting_transcript({call_id?, query?})`** is registered by `plugins/meeting-tools.ts` through `registerTools(["scribe"], […])` (`mcp/registry.ts`), so only Scribe has it. `ToolCtx.chatId` and `ToolCtx.requesterUserId` are the current chat and requester.
  - **In chat C** it returns the published notes of calls held in C whose notetaker was this agent: `{call_id, chat_title, started_at, duration_min, speakers, not_captured, notes_md, action_items, calls:[{call_id, started_at}]}`, with no transcript lines.
  - **In Scribe's DM with the requester** it returns the requester's own invited calls, drafts included (`published: false`), plus `transcript: [{t:"mm:ss", speaker, text}]` and `truncated`.
    - The transcript holds ≤ 300 lines, the newest kept.
    - With `query`, it holds the lines containing any query word of ≥ 3 chars, ±1 line of context, ≤ 60 lines.
  - **Anywhere else** → `{error:"no_call_notes_here"}`.
  - The verbatim transcript is never returned outside the inviter's DM.
- **Naming.** "call" is the session everywhere in the bridge, API, tables and UI. "meeting" is kept only where the spec fixed it: memory `kind=meeting`, the MCP tool `meeting_transcript` and the worker package `services/meeting-agent` (`sa_meeting`).
- **Ports and env.** LiveKit 7880 (ws), 7881 (tcp), UDP 50000–50100, bound to 127.0.0.1 unless `SA_LIVEKIT_BIND`/`SA_LIVEKIT_NODE_IP` are set (tailnet sharing of calls is out of scope). API key name is fixed `sa-dev`, and the secret is `.run/livekit.secret` (`LIVEKIT_API_SECRET`). Bridge env: `LIVEKIT_URL` (default `ws://127.0.0.1:7880`), `LIVEKIT_PUBLIC_URL` (default = `LIVEKIT_URL`), `LIVEKIT_API_SECRET`, `MEETING_TOKEN` (`.run/meeting.token`, guards `/internal/calls/*`), `AUDIO_URL` (default `http://127.0.0.1:8645`), `AUDIO_TOKEN`, `SA_NOTETAKER`, `SA_CALL_E2EE`, `SA_NOTES_INTERVAL_MS`.

## Bound to the memory + approvals seams

These names come from `docs/relay/plans/2026-10-25-memory-approvals.md` § "For later plans (stable seams)" and are used as is:

| need | name |
|---|---|
| server events | `services/bridge/src/approvals/events.ts` `publish(userIds, event)`; T1 extends the protocol `ServerEvent` union with this plan's events |
| web events | `apps/web/src/lib/sse.ts` `openEvents` (fetch streaming with Bearer, not `EventSource`), opened once by `ApprovalsProvider` in `apps/web/src/approvals/store.tsx`; T12 forwards this plan's events to `dispatchBridgeEvent` |
| gated tool | `services/bridge/src/approvals/service.ts` `registerGatedTool`, `requestApproval({…, ttlMs})`, `Executor`, `ApproverRule`, `ArgsError`; the web `ApprovalCard` renders `Approval.preview` generically, so it needs no change |
| MCP tools | `services/bridge/src/mcp/registry.ts` `registerTools(templates, tools)`, `RegisteredTool`, `ToolCtx`, `invokeTool` |
| memory | `services/bridge/src/memory/client.ts` `memory()` → `ingest(IngestRequest)`, `setMemoryForTests`; `SourceType` `meeting` |

## Global Constraints

- T1 conventions: TS `@sa/*`, NodeNext `.js` imports (web: Bundler, no extension), Biome, vitest, pytest + ruff for Python. Commits `feat(voice): …` / `feat(calls): …` / `test(calls): …`, one per task.
- Only T2 changes `package.json` files, `pnpm-lock.yaml`, `pyproject.toml` files, `uv.lock`, the `Makefile` or `infra/scripts/*`. A missing dependency means NEEDS_CONTEXT.
- Public repo: no client company or product names anywhere, and no absolute paths of this machine. `git grep -inE "real[t]yme|gate[x]"` must print nothing before every commit, commit messages included.
- Local only: no third-party URLs at runtime (no STUN/TURN services, no CDN workers; the LiveKit E2EE worker is bundled by Vite).
- D-4: the notetaker never publishes audio, video or data, so its token has `canPublish: false`.
- No transcript text, notes, audio, tokens, media keys or PINs in logs. Log ids, sizes, durations and counts. The media key is never written to the DB.
- UI copy in English, matching the mockups, and no crypto jargon beyond "chat key".
- `make check` passes without models, without LiveKit and without audio-api. Bridge tests use `AGENT_RUNTIME=echo`, fakes and injected spawners, and Python tests use `FakeRoom` and `httpx.MockTransport`. Only T14 starts `make up`/`make dev`, LiveKit, audio-api or the LLM, and it runs alone in the last wave.
- Protected acceptance tests stay unchanged and green, and new tests go into new files. They are `packages/protocol/test/protocol.test.ts`, `services/bridge/test/host.test.ts`, the MCP tests, the templates test, and the memory and ops-sim tests.
- `packages/protocol/src/roster.ts` is not edited, and `infra/hermes/templates/scribe.md` only gets one appended paragraph (T8).
- The only protected test this plan may knowingly change is `services/bridge/test/mcp.test.ts`, and only if it asserts Scribe's exact tool list. Its test-author task is **T8**, which adds `meeting_transcript` to that single expectation and records it in the ledger. Any other protected test going red → BLOCKED.
- `livekit-server` is not installed on this Mac. Installing it is a human step (`brew install livekit`). Nothing may fail because it is missing: scripts print a hint and `make call-smoke` prints `SKIPPED: …` and exits 0.

## Review Focus

- A decliner's (or a not-yet-answered person's) audio is never subscribed, never transcribed and never stored. A segment for a non-accepted speaker is rejected by the bridge even if a buggy worker sends it. Switching from accepted to declined stops capture within 2 s.
- D-3: interim/final notes, `call.notes` events, `GET /notes` and drafts in `meeting_transcript` reach only the inviter until approval. Deny or expiry posts nothing and ingests nothing. `meeting_transcript` never returns unpublished calls outside the inviter's DM, or calls from another chat.
- The reminder DM goes out at most once per approval round. `Publish notes again` works only for the inviter and only from `not_published`. `call.notes_published` reaches only active human members of the call's chat. The approval's chat is the inviter's DM, never the call's chat.
- The final summary runs exactly once per notetaker, even when stop, end and worker exit race. Only one call per chat and one active notetaker per call can exist.
- The notetaker token cannot publish (D-4). `/internal/calls/*` refuses non-loopback callers and a wrong `MEETING_TOKEN`. The LiveKit webhook verifies its signature.
- No worker process survives a bridge restart (pid files). The media key and LiveKit token never appear in argv, env dumps, the DB or logs.
- Voice: one STT per voice message no matter how many agents are in the chat. Agents never answer agent voice replies. `voice.chunk`/`latency.sample` go only to the requester. A stopped turn sends no audio.
- Meeting STT shares whisper-server with chat voice. The live task reports chat voice latency during a call, and the parakeet fallback (P4) is a follow-up if it degrades.

## Before the run (human)

- Optional, for the live call check: `brew install livekit`. Without it T14 reports the call smoke as SKIPPED and still runs the voice smoke.
- `make models` done (whisper, Kokoro voices, LLM). T14 starts the stack itself.

## Tasks

### T1: Protocol, migration, engine message ids, host API and event ports

`packages/protocol/src/index.ts`: add the block below **above** `TextMeta` (it uses `Id` and `B64`, which are declared at the top).

```ts
// ---- Voice and calls ----
export const MAX_VOICE_MS = 60_000;
export const VoiceInfo = z.object({
  duration_ms: z.number().int().positive().max(MAX_VOICE_MS),
});
export type VoiceInfo = z.infer<typeof VoiceInfo>;

export const VoiceLatency = z.object({
  stt_ms: z.number().int().nonnegative(),
  first_token_ms: z.number().int().nonnegative().optional(),
  first_audio_ms: z.number().int().nonnegative().optional(),
  total_ms: z.number().int().nonnegative(),
});
export type VoiceLatency = z.infer<typeof VoiceLatency>;

export const ActionItem = z.object({
  owner: z.string().min(1).max(80),
  text: z.string().min(1).max(300),
  due: z.string().min(1).max(40).optional(),
});
export type ActionItem = z.infer<typeof ActionItem>;

/** Call start/end marker carried in a text message (inside the ciphertext). */
export const CallMeta = z.object({
  call_id: Id,
  op: z.enum(["started", "ended"]),
  /** LiveKit media key, base64url of 32 random bytes; never sent to the bridge DB */
  media_key: B64.optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});
export type CallMeta = z.infer<typeof CallMeta>;

export const MeetingMeta = z.object({
  call_id: Id,
  action_items: z.array(ActionItem).max(30),
});

/** Scribe's DM about call notes: review them (pending) or publish them again (not_published). */
export const CallNotesRef = z.object({
  call_id: Id,
  notes_id: Id,
  state: z.enum(["pending", "not_published"]),
});
```

`TextMeta` gains these fields:

```ts
  /** voice reply timings, measured by the bridge */
  latency: VoiceLatency.optional(),
  /** the voice file message that speaks this text */
  audio_id: Id.optional(),
  /** this text is the transcript of that voice message */
  transcript_of: Id.optional(),
  call: CallMeta.optional(),
  meeting: MeetingMeta.optional(),
  call_notes: CallNotesRef.optional(),
```

The `file` variant of `MessageBody` gains `voice: VoiceInfo.optional(),`.

Then append at the end of the file:

```ts
export const ConsentDecision = z.enum(["pending", "accepted", "declined"]);
export type ConsentDecision = z.infer<typeof ConsentDecision>;
export const NotetakerStatus = z.enum(["active", "stopped", "finished", "failed"]);
export type NotetakerStatus = z.infer<typeof NotetakerStatus>;
export const WorkerState = z.enum(["starting", "joined", "left", "error", "fake"]);
export type WorkerState = z.infer<typeof WorkerState>;

export const CallParticipant = z.object({
  user_id: z.string(),
  name: z.string(),
  in_call: z.boolean(),
  consent: ConsentDecision,
});
export type CallParticipant = z.infer<typeof CallParticipant>;

export const CallNotetaker = z.object({
  id: Id,
  agent_id: z.string(),
  agent_name: z.string(),
  invited_by: z.string(),
  invited_by_name: z.string(),
  invited_at: z.number().int(),
  status: NotetakerStatus,
  worker: WorkerState,
  stopped_by_name: z.string().nullable(),
});
export type CallNotetaker = z.infer<typeof CallNotetaker>;

export const CallInfo = z.object({
  id: Id,
  chat_id: Id,
  room: z.string(),
  started_by: z.string(),
  started_at: z.number().int(),
  ended_at: z.number().int().nullable(),
  anchor_message_id: Id.nullable(),
  e2ee: z.boolean(),
  participants: z.array(CallParticipant),
  notetaker: CallNotetaker.nullable(),
});
export type CallInfo = z.infer<typeof CallInfo>;

export const CallToken = z.object({
  available: z.boolean(),
  url: z.string(),
  token: z.string(),
  identity: z.string(),
});
export type CallToken = z.infer<typeof CallToken>;

export const CallSegment = z.object({
  id: z.number().int(),
  speaker_user_id: z.string(),
  speaker_name: z.string(),
  /** ms since the call started */
  t_ms: z.number().int().nonnegative(),
  text: z.string(),
});
export type CallSegment = z.infer<typeof CallSegment>;

export const CallNotesStatus = z.enum(["draft", "pending_approval", "published", "not_published"]);
export const CallNotes = z.object({
  id: Id,
  version: z.number().int().min(1),
  final: z.boolean(),
  body_md: z.string(),
  action_items: z.array(ActionItem),
  status: CallNotesStatus,
  approval_id: z.string().nullable(),
});
export type CallNotes = z.infer<typeof CallNotes>;

export const AnchorRequest = z.object({ message_id: Id });
export const NotetakerInvite = z.object({ media_key: B64.optional() });
export const ConsentRequest = z.object({ decision: z.enum(["accepted", "declined"]) });

/** worker → bridge (internal) */
export const SegmentIn = z.object({
  speaker: z.string().regex(/^user:[A-Za-z0-9_-]{1,64}$/),
  /** epoch ms */
  t0_ms: z.number().int().nonnegative(),
  t1_ms: z.number().int().nonnegative(),
  text: z.string().min(1).max(4000),
  lang: z.string().max(8).optional(),
});
export type SegmentIn = z.infer<typeof SegmentIn>;
export const WorkerReport = z.object({
  state: z.enum(["joined", "left", "error"]),
  detail: z.string().max(200).optional(),
});
export const WorkerStateResponse = z.object({
  status: NotetakerStatus,
  /** LiveKit identities (`user:<id>`) that may be subscribed right now */
  consented: z.array(z.string()),
});
export type WorkerStateResponse = z.infer<typeof WorkerStateResponse>;

/** SSE events added by this plan (event name = `type`, data = the JSON object). */
export const CallEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("call.updated"), call: CallInfo }),
  z.object({ type: z.literal("call.segment"), call_id: Id, segment: CallSegment }),
  z.object({
    type: z.literal("call.notes"),
    call_id: Id,
    version: z.number().int().min(1),
    final: z.boolean(),
  }),
  z.object({
    type: z.literal("call.notes_published"),
    call_id: Id,
    chat_id: Id,
    message_id: Id,
    title: z.string().max(200),
  }),
]);
export type CallEvent = z.infer<typeof CallEvent>;
export const VoiceEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("voice.chunk"),
    chat_id: Id,
    /** the user's voice message this audio answers */
    source_id: Id,
    seq: z.number().int().nonnegative(),
    text: z.string().max(1000),
    wav_b64: z.string(),
  }),
  z.object({
    type: z.literal("latency.sample"),
    chat_id: Id,
    source_id: Id,
    latency: VoiceLatency,
  }),
]);
export type VoiceEvent = z.infer<typeof VoiceEvent>;
```

Then **move** the existing `export const ServerEvent = z.discriminatedUnion("type", [...])` and its `type` export (memory + approvals plan) below `VoiceEvent`, keeping its four members, and add this plan's members (zod 4 `options`):

```ts
export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), user_id: z.string() }),
  z.object({ type: z.literal("approval"), approval: Approval }),
  z.object({ type: z.literal("approval_public"), approval: ApprovalPublic }),
  z.object({ type: z.literal("question"), question: Question }),
  ...CallEvent.options,
  ...VoiceEvent.options,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
```

If the merged union has gained members since that plan was written, keep them all; only append the two spreads.

`packages/client/src/engine.ts`: every send returns the new message id (the bridge and the web need it for anchors and `audio_id`). Change `sendBody` to `private async sendBody(chatId: string, body: MessageBody, ts?: number): Promise<string>` and `return id;` after `await this.link.send(...)`. `sendText`, `sendReaction` and `sendSystem` return `Promise<string>`. `sendFile` becomes:

```ts
  async sendFile(
    chatId: string,
    file: { name: string; mime: string; bytes: Uint8Array },
    opts?: { replyTo?: string; voice?: { duration_ms: number } },
  ): Promise<string> {
    await this.keyFor(chatId); // fail early with no_key
    const enc = encryptBytes(file.bytes);
    const blobId = randomId();
    await this.link.putBlob(blobId, chatId, enc.ciphertext);
    const body: MessageBody = {
      type: "file",
      blob_id: blobId,
      name: file.name,
      mime: file.mime,
      size: file.bytes.length,
      key: enc.key,
      nonce: enc.nonce,
    };
    if (opts?.replyTo) body.reply_to = opts.replyTo;
    if (opts?.voice) body.voice = opts.voice;
    return this.sendBody(chatId, body);
  }

  /** Sends any message body; resolves the message id. */
  sendMessage(chatId: string, body: MessageBody): Promise<string> {
    return this.sendBody(chatId, body);
  }
```

If T1 already changed one of these signatures, keep its extra options and only add the return value, `voice` and `sendMessage`. Fix any caller that typechecks against `Promise<void>`, for example a test mock returning `undefined`, by returning `"id-test"`.

`services/bridge/src/agents/api.ts`: add the imports and two optional members to `AgentHostApi`:

```ts
import type { MessageBody } from "@sa/protocol";
import type { ChatMessage } from "./runtime.js";
// inside interface AgentHostApi:
  /** Sends one message from the agent's device in chatId; resolves the message id. */
  sendAs?(agentId: string, chatId: string, body: MessageBody): Promise<string>;
  /** One tool-less background completion for this agent on the shared LLM queue (proactive class). */
  complete?(agentId: string, sessionKey: string, messages: ChatMessage[]): Promise<string>;
```

`apps/web/src/lib/bridge-events.ts` (new; T12 feeds it from `ApprovalsProvider`'s `openEvents` handler):

```ts
import type { CallEvent, VoiceEvent } from "@sa/protocol";

export type BridgeEvent = CallEvent | VoiceEvent;
type Handler = (ev: BridgeEvent) => void;
const handlers = new Set<Handler>();

export function onBridgeEvent(h: Handler): () => void {
  handlers.add(h);
  return () => {
    handlers.delete(h);
  };
}

/** Called by the SSE client for every `call.*`, `voice.*` and `latency.*` event. */
export function dispatchBridgeEvent(ev: BridgeEvent): void {
  for (const h of [...handlers]) h(ev);
}
```

`apps/web/src/call/api.ts` (new):

```ts
import type { CallInfo, CallNotes, CallSegment, CallToken } from "@sa/protocol";
import { api } from "../api";

const post = (body?: unknown): RequestInit =>
  body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) };

export const callApi = {
  start: (chatId: string) => api<{ call: CallInfo }>(`/chats/${chatId}/calls`, post()),
  get: (callId: string) => api<CallInfo>(`/calls/${callId}`),
  anchor: (callId: string, messageId: string) =>
    api<{ ok: true }>(`/calls/${callId}/anchor`, post({ message_id: messageId })),
  token: (callId: string) => api<CallToken>(`/calls/${callId}/token`, post()),
  leave: (callId: string) => api<{ ok: true }>(`/calls/${callId}/leave`, post()),
  end: (callId: string) => api<{ ok: true }>(`/calls/${callId}/end`, post()),
  invite: (callId: string, mediaKey?: string) =>
    api<CallInfo>(`/calls/${callId}/notetaker`, post(mediaKey ? { media_key: mediaKey } : {})),
  consent: (callId: string, decision: "accepted" | "declined") =>
    api<CallInfo>(`/calls/${callId}/consent`, post({ decision })),
  stop: (callId: string) => api<CallInfo>(`/calls/${callId}/notetaker/stop`, post()),
  segments: (callId: string) => api<{ segments: CallSegment[] }>(`/calls/${callId}/segments`),
  notes: (callId: string) => api<CallNotes | null>(`/calls/${callId}/notes`),
  republish: (notesId: string) =>
    api<{ approval_id: string }>(`/calls/notes/${notesId}/republish`, post()),
};
```

`services/bridge/src/migrations/006_calls.sql` (new):

```sql
create table sa.calls (
  id text primary key,
  chat_id text not null references sa.chats on delete cascade,
  room text not null unique,
  started_by text not null references sa.users,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  anchor_message_id text,
  e2ee boolean not null default false
);
create unique index calls_one_active_per_chat on sa.calls (chat_id) where ended_at is null;

create table sa.call_participants (
  call_id text not null references sa.calls on delete cascade,
  user_id text not null references sa.users,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (call_id, user_id)
);

create table sa.call_notetakers (
  id text primary key,
  call_id text not null references sa.calls on delete cascade,
  agent_id text not null references sa.agents,
  invited_by text not null references sa.users,
  status text not null default 'active' check (status in ('active', 'stopped', 'finished', 'failed')),
  worker text not null default 'starting' check (worker in ('starting', 'joined', 'left', 'error', 'fake')),
  stopped_by text references sa.users,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index call_notetakers_one_active on sa.call_notetakers (call_id) where status = 'active';

create table sa.call_consents (
  notetaker_id text not null references sa.call_notetakers on delete cascade,
  user_id text not null references sa.users,
  decision text not null check (decision in ('accepted', 'declined')),
  decided_at timestamptz not null default now(),
  primary key (notetaker_id, user_id)
);

create table sa.call_segments (
  id bigserial primary key,
  notetaker_id text not null references sa.call_notetakers on delete cascade,
  speaker_user_id text not null references sa.users,
  t0 timestamptz not null,
  t1 timestamptz not null,
  text text not null check (length(text) <= 4000),
  lang text
);
create index call_segments_by_notetaker on sa.call_segments (notetaker_id, t0);

create table sa.call_notes (
  id text primary key,
  notetaker_id text not null references sa.call_notetakers on delete cascade,
  version int not null,
  final boolean not null default false,
  body_md text not null,
  action_items jsonb not null default '[]',
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'published', 'not_published')),
  approval_id text,
  approval_requested_at timestamptz,
  reminded_at timestamptz,
  published_message_id text,
  created_at timestamptz not null default now(),
  unique (notetaker_id, version)
);
create unique index call_notes_one_final on sa.call_notes (notetaker_id) where final;
```

Tests:
- `packages/protocol/test/voice-calls.test.ts` (new; `protocol.test.ts` is protected): `ServerEvent` parses a `call.segment` and still parses `hello`. A file body with `voice: {duration_ms: 61000}` is rejected and one with `12000` passes. `TextMeta` accepts `latency`, `audio_id`, `transcript_of`, `call` and `meeting` with 31 action items rejected. `SegmentIn` rejects `speaker: "agent:x"`.
- `packages/client/test/engine-ids.test.ts` (new; leave `engine.test.ts` unchanged): `sendText` and `sendFile(…, {voice})` resolve the envelope id the fake relay received, and the decrypted file body carries `voice`.

### T2: Dependencies, LiveKit config and scripts, worker package skeleton, Make targets

JS dependencies (commit the lockfile):

```bash
pnpm --filter @sa/bridge add livekit-server-sdk@^2
pnpm --filter @sa/web add livekit-client@^2
```

`livekit-client` is used directly; `@livekit/components-react` is not needed for the audio-only custom layout. `e2e/package.json` scripts gain `"voice-smoke": "tsx live/voice-smoke.ts"` and `"call-smoke": "tsx live/call-smoke.ts"`.

Python worker package `services/meeting-agent/pyproject.toml`:

```toml
[project]
name = "sa-meeting"
version = "0.0.0"
description = "Sovereign Agents call notetaker: per-speaker VAD, local STT, segments to the bridge"
requires-python = ">=3.12,<3.14"
dependencies = ["httpx>=0.27", "numpy>=1.26", "pydantic>=2.8"]

[project.optional-dependencies]
live = ["livekit>=1.0", "livekit-agents[silero]>=1.2"]

[project.scripts]
sa-meeting = "sa_meeting.main:run"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/sa_meeting"]
```

`services/meeting-agent/src/sa_meeting/__init__.py` holds only a docstring line. `services/meeting-agent/src/sa_meeting/main.py` is a stub that T9 replaces:

```python
"""sa-meeting CLI (T9 adds `join` and `synth`)."""

import sys


def run() -> None:
    print("sa-meeting: not implemented yet", file=sys.stderr)
    sys.exit(2)
```

Root `pyproject.toml`:
- `[tool.uv.workspace].members` adds `"services/meeting-agent"`.
- `[tool.uv.sources]` adds `sa-meeting = { workspace = true }`.
- `dev` group adds `"sa-meeting"`; `live` group adds `"sa-meeting[live]"`.
- `testpaths` adds `"services/meeting-agent/tests"`.

Then run `uv lock` and commit `uv.lock`. If `livekit-agents[silero]` cannot resolve for darwin arm64 / Python 3.12–3.13, pin the newest version that does and say so in the commit. Never move it into base dependencies.

`infra/livekit.yaml` (new):

```yaml
# Local call server for the demo (calls only). Keys come from LIVEKIT_KEYS (infra/scripts/livekit.sh).
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: false
  node_ip: 127.0.0.1
webhook:
  api_key: sa-dev
  urls:
    - http://127.0.0.1:8647/internal/livekit/webhook
room:
  empty_timeout: 60
  max_participants: 12
logging:
  level: info
```

`infra/scripts/livekit.sh` (new, executable):

```bash
#!/usr/bin/env bash
# Local LiveKit call server (calls only). Installing it is a human step: brew install livekit.
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/scripts/secrets.sh
PID=.run/livekit.pid
LOG=.run/livekit.log
running() { [[ -f $PID ]] && kill -0 "$(cat "$PID")" 2>/dev/null; }
case ${1:-start} in
  start)
    if ! command -v livekit-server >/dev/null 2>&1; then
      echo "calls: livekit-server not installed (human step: brew install livekit); chat and voice still work"
      exit 0
    fi
    if running; then echo "calls: livekit already running (pid $(cat "$PID"))"; exit 0; fi
    args=(--config infra/livekit.yaml --bind "${SA_LIVEKIT_BIND:-127.0.0.1}")
    if [[ -n ${SA_LIVEKIT_NODE_IP:-} ]]; then args+=(--node-ip "$SA_LIVEKIT_NODE_IP"); fi
    LIVEKIT_KEYS="$LIVEKIT_API_KEY: $LIVEKIT_API_SECRET" nohup livekit-server "${args[@]}" >"$LOG" 2>&1 &
    echo $! >"$PID"
    for _ in $(seq 1 40); do
      if curl -fsS http://127.0.0.1:7880/ >/dev/null 2>&1; then
        echo "calls: livekit on ws://127.0.0.1:7880"
        exit 0
      fi
      sleep 0.25
    done
    echo "calls: livekit did not answer on :7880, see $LOG" >&2
    exit 1
    ;;
  stop)
    if running; then kill "$(cat "$PID")" 2>/dev/null || true; fi
    rm -f "$PID"
    ;;
  status)
    if running; then echo running; else echo stopped; fi
    ;;
  *)
    echo "usage: livekit.sh start|stop|status" >&2
    exit 2
    ;;
esac
```

`infra/scripts/secrets.sh` appends:

```bash
export LIVEKIT_API_KEY=sa-dev
ensure_secret LIVEKIT_API_SECRET livekit.secret
ensure_secret MEETING_TOKEN meeting.token
```

Also add `ensure_secret AUDIO_TOKEN audio.token`; the memory plan does not add it.

Script and Make edits:
- `infra/scripts/dev.sh` and `infra/scripts/demo.sh`: call `bash infra/scripts/livekit.sh start` after Postgres is up (it never fails when LiveKit is missing).
- `infra/scripts/up.sh`: start audio-api after whisper with the existing helper, `start audio env AUDIO_TOKEN="$AUDIO_TOKEN" uv run sa-audio`, then `wait_http audio http://127.0.0.1:8645/healthz 60`. Source `infra/scripts/secrets.sh` first if `up.sh` does not already, so `AUDIO_TOKEN` is set. The memory plan does not start audio-api; this plan does.
- `infra/scripts/down.sh`: stop `audio` before `whisper`, and call `bash infra/scripts/livekit.sh stop`.
- `infra/scripts/prereqs.sh`: change the hint to `want livekit-server "brew install livekit   # calls (optional)"`.
- `.env.example`: document `LIVEKIT_API_SECRET`, `MEETING_TOKEN`, `SA_NOTETAKER`, `SA_CALL_E2EE`, `SA_NOTES_INTERVAL_MS`, `SA_CALL_GRACE_MS` and `AUDIO_URL`, one comment each, defaults as in Decisions.
- `README.md`: a short "Calls (optional)" paragraph covering the human step `brew install livekit`, `make livekit`, and that calls work local-only on 127.0.0.1.
- `Makefile`: add the targets below plus `.PHONY` entries. Make sure the target that syncs the `live` group also installs `sa-meeting[live]` (adding it to the group is enough).

```make
livekit: ## start the local call server if installed (brew install livekit); prints a hint otherwise
	bash infra/scripts/livekit.sh start

voice-smoke: ## live: a voice message to Ops gets a spoken reply; prints latency (needs make up + make dev)
	pnpm --filter @sa/e2e run voice-smoke

call-smoke: ## live: two synthetic speakers, one decliner and the notetaker; SKIPPED without livekit-server
	@command -v livekit-server >/dev/null 2>&1 || { echo "SKIPPED: livekit-server is not installed (human step: brew install livekit)"; exit 0; }
	pnpm --filter @sa/e2e run call-smoke
```

No new tests: `make check` syntax-checks the scripts, and the typecheck covers the packages.

### T3: Bridge voice pipeline modules (audio client, sentences, WAV, speaker)

New files only, no host changes. All are pure or injectable.

`services/bridge/src/voice/audio-client.ts`:

```ts
export type Transcript = { text: string; language: string; duration: number };
export interface AudioClient {
  transcribe(bytes: Uint8Array, filename: string, language?: string): Promise<Transcript>;
  /** One sentence or short text → 16-bit PCM WAV bytes. */
  speak(text: string, language: string): Promise<Uint8Array>;
}

export const TTS_LANGS = new Set(["en", "fr", "es", "it", "de", "ro"]);
export function ttsLanguage(detected: string | undefined): string {
  const l = (detected ?? "").toLowerCase().slice(0, 2);
  return TTS_LANGS.has(l) ? l : "en";
}

export function httpAudioClient(opts: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): AudioClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  const timeout = opts.timeoutMs ?? 30_000;
  const headers = { "X-Internal-Token": opts.token };
  return {
    async transcribe(bytes, filename, language = "auto") {
      const form = new FormData();
      form.set("file", new Blob([bytes]), filename);
      form.set("language", language);
      const res = await fetch(`${base}/v1/audio/transcriptions`, {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`stt_failed_${res.status}`);
      const j = (await res.json()) as Partial<Transcript>;
      return {
        text: String(j.text ?? "").trim(),
        language: String(j.language ?? "en"),
        duration: Number(j.duration ?? 0),
      };
    },
    async speak(text, language) {
      const res = await fetch(`${base}/v1/audio/speech`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ input: text.slice(0, 4000), language, stream: false }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`tts_failed_${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

export function audioClientFromEnv(env = process.env): AudioClient | null {
  if (!env.AUDIO_TOKEN) return null;
  return httpAudioClient({ baseUrl: env.AUDIO_URL || "http://127.0.0.1:8645", token: env.AUDIO_TOKEN });
}
```

`services/bridge/src/voice/sentences.ts`:

```ts
const BOUNDARY = /([.!?…]+["')\]]*)(\s+)|\n{2,}/g;
const MIN_SENTENCE = 12;

/** Markdown → speakable text: drops code blocks, links' URLs, emphasis, headings and bullets. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~#>]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Streams sentences out of growing text. push() takes deltas; flush() returns the rest. */
export class SentenceSplitter {
  private buf = "";
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let last = 0;
    for (const m of this.buf.matchAll(BOUNDARY)) {
      const end = (m.index ?? 0) + m[0].length;
      const s = this.buf.slice(last, end).trim();
      if (s.length >= MIN_SENTENCE) {
        out.push(s);
        last = end;
      }
    }
    this.buf = this.buf.slice(last);
    return out;
  }
  flush(): string[] {
    const s = this.buf.trim();
    this.buf = "";
    return s ? [s] : [];
  }
}
```

`services/bridge/src/voice/wav.ts`: `parseWav(bytes) → {sampleRate, channels, bitsPerSample, data: Uint8Array}`. It walks the RIFF chunks (does not assume a 44-byte header) and throws `bad_wav` on a non-RIFF/WAVE input or a missing `fmt `/`data` chunk. `concatWav(parts: Uint8Array[]): Uint8Array` requires equal formats (throws `wav_format_mismatch`) and writes one canonical 44-byte header. `wavDurationMs(bytes): number`.

`services/bridge/src/voice/voice-turn.ts`: the speaking half of a voice turn.

```ts
import type { AudioClient } from "./audio-client.js";
import { concatWav, wavDurationMs } from "./wav.js";
import { SentenceSplitter, speakable } from "./sentences.js";

export const MAX_SPOKEN_CHARS = 600;
export type SpokenChunk = { seq: number; text: string; wav: Uint8Array };
export type SpeakResult = { wav: Uint8Array | null; durationMs: number; firstAudioAt: number | null };

export class Speaker {
  constructor(
    private audio: AudioClient,
    private language: string,
    private onChunk: (c: SpokenChunk) => void,
    private now: () => number = Date.now,
  ) {}
  push(delta: string): void;          // split, then enqueue speakable sentences
  finish(): Promise<SpeakResult>;     // flush the rest, await the queue, concat
  abort(): void;                      // drop queued sentences; finish() resolves wav null
}
```

Behaviour:
- Sentences are synthesised strictly in order through one promise chain, and `seq` starts at 0.
- `speakable()` is applied per sentence, and empty results are skipped.
- After `MAX_SPOKEN_CHARS` spoken characters, later sentences are ignored.
- A TTS error on a sentence is logged (id and size only), that sentence is skipped and the rest go on.
- `firstAudioAt` = `now()` when the first WAV arrives.
- `finish()` returns `wav: null` when nothing was spoken.

Tests (vitest, fake `AudioClient`):
- `services/bridge/test/voice-sentences.test.ts`: deltas `"Hello there, Ana. The clu"`, `"ster is fine! Ok"` yield `["Hello there, Ana.", "The cluster is fine!"]`, and `flush()` gives `["Ok"]`. `speakable` strips a code block and a link URL.
- `services/bridge/test/voice-wav.test.ts`: two generated 100 ms 24 kHz WAVs concat into 200 ms, and a mismatched sample rate throws.
- `services/bridge/test/voice-turn.test.ts`: chunks arrive in order even when the fake TTS resolves out of order. The 600-char cap holds. A failing sentence is skipped. `abort()` → `wav: null`.

### T4: Agent host — voice turns, `sendAs`, `complete`

Edit `services/bridge/src/agents/host.ts` (T1-merged version) and add `services/bridge/src/agents/voice-trigger.ts`:

```ts
const voiceSeen = new Map<string, number>(); // message id → expiry (ms)
const SEEN_MS = 10 * 60_000;

/** True once per voice message id across all agent devices (10 min memory). */
export function claimVoice(messageId: string, now = Date.now()): boolean {
  for (const [id, until] of voiceSeen) if (until < now) voiceSeen.delete(id);
  if (voiceSeen.has(messageId)) return false;
  voiceSeen.set(messageId, now + SEEN_MS);
  return true;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Hey Ops, …", "Ops: …", "@Ops …" at the start of a transcript. */
export function addressesAgent(transcript: string, agentName: string): boolean {
  return new RegExp(`^\\W*(?:hey|hi|ok|okay)?[\\s,]*@?${escape(agentName)}\\b`, "i").test(transcript);
}
```

Host behaviour (see Decisions "Voice messages", "Which voice messages an agent answers" and "Voice reply"):
- In `onMessage`, a `file` body with `voice` from a human device goes to `voiceMessage(dev, m)`. Every agent device sees the message, but only the device that wins `claimVoice(m.id)` transcribes it. That device evaluates the rules for **every** agent in the chat: the DM rule, T1's thread owner for follow-ups, and `addressesAgent` against each agent name in member order, first match wins. The answering agent's device then posts. Use `dev.engine.downloadFile` → `audio.transcribe(bytes, name, "auto")`.
- Audio comes from `audioClientFromEnv()`, injectable through `AgentHostOptions.audio` for tests. With no client, voice messages are ignored and the bridge logs `voice disabled` once.
- The answering agent posts: (1) the transcript text with `meta.transcript_of`. (2) The T1 turn with the transcript as the user's text: same reactions, live status, receipts, Stop and queue. Feed `onDelta` to a `Speaker` whose `onChunk` does `publish([requester], {type:"voice.chunk", chat_id, source_id: m.id, seq, text, wav_b64})`. (3) `sendFile(chat, {name:"reply-<ts>.wav", mime:"audio/wav", bytes}, {replyTo, voice:{duration_ms}})`. (4) The reply text with `meta.audio_id` and `meta.latency`, then `publish([requester], {type:"latency.sample", …})` (`publish` from `../approvals/events.js`). If T1's reply sending does not take extra meta, add a turn option `extraMeta` rather than duplicating the reply path.
- A stopped turn calls `speaker.abort()` and sends no file. STT error → the reply "I couldn't transcribe that voice message." in the thread with ⚠️. TTS producing nothing → the text reply only.
- Implement `sendAs(agentId, chatId, body)` with `deviceFor(agentId)` → `engine.sendMessage`, throwing `agent_not_ready` when there is no device. Implement `complete(agentId, sessionKey, messages)` as a turn on the T1 queue in the proactive class: `setForceFirstTool(agentId, false)` for the call, restore the previous value afterwards, 180 s timeout, return the content with think blocks split off.

Tests:
- `services/bridge/test/voice-host.test.ts`, echo runtime + fake audio + two agents in one group chat: a voice message "Hey Ops, status?" is transcribed **once**, only Ops answers, the order is transcript → file → reply, and the reply carries `meta.audio_id` = the file id and a `latency` with `total_ms ≥ stt_ms`. A voice message in a DM with Nora is answered without a name. A voice message from an agent device triggers nothing. With failing STT, the "couldn't transcribe" reply is sent. A stopped turn sends no file.
- `services/bridge/test/host-send.test.ts`: `sendAs` resolves the id the relay received. `complete` turns forced first tool off during the call and restores it, and it waits behind a queued human turn.

### T5: Calls API — store, tokens, consent, routes, webhook, plugin

New `services/bridge/src/calls/` modules and the plugin `services/bridge/src/plugins/calls.ts` (`export const plugin: BridgePlugin`, name `calls`). The plugin loader (T1) mounts it, so `app.ts`/`main.ts` are not edited.

- `calls/store.ts`: all SQL. `createCall`, `activeCallForChat`, `getCallInfo(callId) → CallInfo`, `markJoined`/`markLeft`, `endCall`, `inviteNotetaker` (inserts the notetaker + the inviter's `accepted` consent in one transaction; the unique index → `409 notetaker_active`), `setConsent`, `stopNotetaker`, `participantsInCall`, `consentedIdentities(notetakerId)` (`user:<id>` for accepted **and** in-call users). Times in `CallInfo` are epoch ms.
- `calls/consent.ts` (pure): `consentOf(userId, inviterId, decisions)`. `capturable(userId, call)` is true when the decision is `accepted`, the user is in the call and the notetaker is `active`. `notCapturedCount(call)` counts users who ever joined minus the accepted ones.
- `calls/tokens.ts`: `userToken({callId, userId, name})` and `notetakerToken({callId, agentId, invitedByName})` per Decisions "Tokens", using `LIVEKIT_API_KEY=sa-dev` and `LIVEKIT_API_SECRET`. `roomName(callId) = "call-" + callId`.
- `calls/livekit-health.ts`: `livekitAvailable()`, an HTTP GET of `LIVEKIT_URL` with `ws`→`http`, a 1 s timeout and a 5 s cache. Injectable for tests.
- `calls/routes.ts`. Every route requires a session. "Member" = an active human member of the call's chat, and "participant" = a member with a `call_participants` row.
  - `POST /api/chats/:id/calls` (member) → `201 {call}`, or `200 {call}` when one is active. `e2ee = SA_CALL_E2EE === "1"`.
  - `GET /api/calls/:id` (member).
  - `POST /api/calls/:id/anchor {message_id}`: starter only, once (`409 anchor_set`).
  - `POST /api/calls/:id/token` (member, call not ended) → `CallToken`, marking the user joined.
  - `POST /api/calls/:id/leave` (participant); `POST /api/calls/:id/end` (starter or chat owner).
  - `POST /api/calls/:id/notetaker {media_key?}` (participant in call). Scribe must be an active chat member (`409 notetaker_not_in_chat`). T6's `notetakers.start` starts the worker; until T6 lands, plugin wiring passes a no-op.
  - `POST /api/calls/:id/consent {decision}`: participant, active notetaker, not the inviter (`409 inviter_always_consents`).
  - `POST /api/calls/:id/notetaker/stop` (participant).
  - `GET /api/calls/:id/segments` (participant; the latest notetaker's segments with `t_ms` relative to `started_at`).
  - `GET /api/calls/:id/notes`: inviter only, else `403 notes_private`; returns the latest version or `null`.
  - Errors use `{error}` with 400/403/404/409. After each state change, emit `call.updated` to all active human chat members with `publish` (`approvals/events.ts`). The last-leave grace timer lives here (`SA_CALL_GRACE_MS`, default 30 000; `setTimeout`, cleared on re-join).
- `calls/webhook.ts`: `POST /internal/livekit/webhook` (loopback only), a raw-body parser for `application/webhook+json`, and `WebhookReceiver(sa-dev, secret).receive(body, authorization)`. `participant_joined`/`participant_left` for `user:<id>` identities → `markJoined`/`markLeft`; `room_finished` → `endCall`. A bad signature → 401.
- `plugins/calls.ts`: `routes` mounts `routes.ts` + `webhook.ts`; `stop` clears timers. T6/T7 extend this file.

Tests:
- `services/bridge/test/call-tokens.test.ts`: decode with `jose` or the SDK's `TokenVerifier`. The user token can publish only the microphone. The notetaker token has `canPublish:false`, `canPublishData:false` and identity `agent:<id>`. Room = `call-<id>`.
- `services/bridge/test/call-consent.test.ts`: the pure rules, covering an inviter with no row → accepted, a declined user → not capturable, accepted but left → not capturable, and a stopped notetaker → nothing capturable.
- `services/bridge/test/call-routes.test.ts` (pglite, injected health = down):
  - A second start returns the same call. Token → `available:false` and the user listed `in_call`.
  - A non-member gets 403 everywhere. Invite without Scribe in the chat → 409.
  - Vlad accepts and Rareș declines → `CallInfo` shows both, and the inviter stays accepted.
  - Anyone in the call can stop. `GET /notes` returns 403 for a non-inviter.
  - A webhook with a bad signature → 401.
  - `call.updated` reaches every chat member (assert with `subscribe` from `approvals/events.ts` and fake senders).

### T6: Notetaker supervisor, internal worker routes, summaries

- `calls/notetaker.ts`: `Notetakers` class with an injectable `Spawner` (`spawn(cmd, args, {env, stdin}) → {pid, onExit, kill}`).
  - `start(callId, notetakerId, mediaKey?)` acts per `SA_NOTETAKER`. `worker`: check `livekitAvailable()` (else `503 livekit_unavailable`), mint the notetaker token, spawn the command from Decisions "Worker process", write the stdin JSON line, close stdin and write the pid file. `fake`: set `worker='fake'`. `off`: throw `notetaker_disabled`.
  - `stopProcess(notetakerId)` (SIGTERM, then SIGKILL after 5 s).
  - On exit with code ≠ 0 while `active` → `status='failed'`, `worker='error'`, and `onFinal`.
  - `cleanupOrphans()` kills pids from `.run/notetakers/*.pid` at plugin init.
  - The media key is held in a `Map` only until spawn.
- `calls/internal-routes.ts` (loopback + `X-Internal-Token: MEETING_TOKEN`, else 403):
  - `GET /internal/calls/notetakers/:id/state` → `WorkerStateResponse`.
  - `POST /internal/calls/notetakers/:id/segments` `SegmentIn` → `403 not_consented` unless `capturable(speaker)` at receipt time, `409 not_active` when not active. Otherwise insert, then emit `call.segment` to users in the call.
  - `POST /internal/calls/notetakers/:id/worker` `WorkerReport` → updates `worker`. `left` while active is ignored (stop drives status).
- `calls/summary.ts`: copy the code below as is.
- `calls/scheduler.ts`: `NotesScheduler` with an injectable clock/interval.
  - Each tick (every `SA_NOTES_INTERVAL_MS`): for every `active` notetaker with segments newer than its last version, run an interim summary.
  - `final(notetakerId)` is called by stop, end and worker failure, and runs **once**: guarded by an in-memory set plus the `call_notes_one_final` unique index; a duplicate insert is a no-op.
  - It awaits any in-flight summary of that notetaker. With zero segments it writes no notes and emits nothing; the inviter's page shows "Nothing was captured."
  - Each summary: load segments + names, `transcriptLines`, then `agentHost.complete` (parts per `chunkLines` when over 14 000 chars, then the merge prompt). On error → `fallbackNotes`. `composeNotes(notesHeader(...), body)`. Insert `call_notes` (version+1, final flag, `action_items = parseActionItems(body)`). Emit `call.notes` to the inviter only.
  - The final summary then calls `onFinalNotes(notes)` (T7 hooks publication; the default is a no-op).
- `plugins/calls.ts`: construct `Notetakers` + `NotesScheduler`, pass `notetakers.start` to the routes, and wire stop/end → `final`. `stop()` kills workers and clears the interval.

`services/bridge/src/calls/summary.ts`:

```ts
import type { ActionItem } from "@sa/protocol";
import type { ChatMessage } from "../agents/runtime.js";

export type SegmentRow = { speakerName: string; t0Ms: number; text: string };
export const MAX_NOTES_CHARS = 7500;
export const SINGLE_PASS_CHARS = 14_000;
export const CHUNK_CHARS = 12_000;

export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function transcriptLines(segments: SegmentRow[], callStartMs: number): string[] {
  return segments.map((s) => `[${mmss(s.t0Ms - callStartMs)}] ${s.speakerName}: ${s.text.trim()}`);
}

export function chunkLines(lines: string[], max = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const raw of lines) {
    const l = raw.slice(0, max);
    if (cur && cur.length + l.length + 1 > max) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export const NOTES_SYSTEM = `You write meeting notes from a call transcript. Use only what the transcript says; never invent names, dates or numbers. Each line is "[mm:ss] Speaker: text". Some attendees were not captured; never guess what they said.
Answer in English Markdown with exactly these four sections, in this order:
## Summary
Three to six sentences.
## Decisions
- One bullet per decision, ending with its time stamp, for example (03:41). Write "- None recorded." when there are none.
## Action items
- [ ] Owner: task (due: when)
Leave out "(due: …)" when no date was said. Use "Unassigned" when nobody took the task. Write "- None recorded." when there are none.
## Open questions
- One bullet per open question, or "- None recorded."`;

export function notesMessages(transcript: string, part?: { i: number; n: number }): ChatMessage[] {
  const intro = part
    ? `This is part ${part.i} of ${part.n} of one call. Write the four sections for this part only.`
    : "Write the notes for this call.";
  return [
    { role: "system", content: NOTES_SYSTEM },
    { role: "user", content: `${intro}\n\nTranscript:\n${transcript}` },
  ];
}

export function mergeMessages(partNotes: string[]): ChatMessage[] {
  return [
    { role: "system", content: NOTES_SYSTEM },
    {
      role: "user",
      content: `Below are notes for consecutive parts of one call. Merge them into one set of the four sections; drop duplicates and keep time stamps.\n\n${partNotes.map((p, i) => `### Part ${i + 1}\n${p}`).join("\n\n")}`,
    },
  ];
}

const ITEM = /^\s*[-*]\s*\[[ xX]\]\s*(?:\*\*)?([^:*\n]{1,80}?)(?:\*\*)?\s*:\s*(.+?)\s*$/;
const DUE = /\s*\(due:?\s*([^)]{1,40})\)\s*$/i;

export function parseActionItems(md: string): ActionItem[] {
  const out: ActionItem[] = [];
  let inSection = false;
  for (const line of md.split("\n")) {
    if (/^#{2,3}\s+/.test(line)) {
      inSection = /^#{2,3}\s+action items/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = ITEM.exec(line);
    if (!m) continue;
    const owner = (m[1] ?? "").trim();
    let text = (m[2] ?? "").trim();
    let due: string | undefined;
    const d = DUE.exec(text);
    if (d) {
      due = (d[1] ?? "").trim() || undefined;
      text = text.slice(0, d.index).trim();
    }
    if (!owner || !text) continue;
    out.push(due ? { owner, text: text.slice(0, 300), due } : { owner, text: text.slice(0, 300) });
    if (out.length === 30) break;
  }
  return out;
}

export type HeaderInput = {
  chatTitle: string;
  startedAtMs: number;
  durationMs: number;
  speakers: string[];
  notCaptured: number;
};

export function notesHeader(h: HeaderInput): string {
  const date = new Date(h.startedAtMs).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const mins = Math.max(1, Math.round(h.durationMs / 60_000));
  const lines = [
    `**Call notes** · ${h.chatTitle} · ${date} · ${mins} min`,
    `Speakers: ${h.speakers.length ? h.speakers.join(", ") : "none"}`,
  ];
  if (h.notCaptured > 0) {
    lines.push(`Not captured: ${h.notCaptured} ${h.notCaptured === 1 ? "person" : "people"} who did not consent`);
  }
  lines.push("Draft by Scribe on this Mac.");
  return lines.join("\n");
}

export function composeNotes(header: string, body: string): string {
  const text = `${header}\n\n${body.trim()}`;
  return text.length <= MAX_NOTES_CHARS ? text : `${text.slice(0, MAX_NOTES_CHARS - 20)}\n\n(notes truncated)`;
}

export function fallbackNotes(lines: string[]): string {
  const tail = lines.slice(-40).map((l) => `> ${l}`);
  return ["## Summary", "The summary could not be generated on this Mac. Last lines of the transcript:", ...tail].join("\n");
}
```

Tests:
- `services/bridge/test/call-summary.test.ts`: `parseActionItems` on the mockup story ("- [ ] Vlad: send the confirmation email (due: Friday)", "- [ ] **Ana**: update the contract", an item outside the section ignored, 31 items → 30). `chunkLines` keeps line boundaries. `composeNotes` truncates at 7500. `notesHeader` never prints a decliner's name and pluralises.
- `services/bridge/test/call-internal.test.ts` (pglite):
  - A segment from an accepted, in-call speaker → 201 and `call.segment` sent only to in-call users.
  - From a declined, pending, left or `agent:` speaker → 403.
  - After stop → 409.
  - Wrong token or non-loopback → 403.
  - `state` lists only accepted, in-call identities and flips within one request after a decline.
- `services/bridge/test/call-notetaker.test.ts` (fake spawner + fake `complete` + fake clock):
  - The stdin JSON holds the token and media key, and argv/env hold neither.
  - Exit code 1 while active → failed + one final.
  - stop + end + exit racing → exactly one final row.
  - An interim summary only with new segments, sent only to the inviter.
  - A throwing `complete` → fallback notes.
  - Over 14 000 chars → part calls + one merge call.

### T7: Publish notes — gated tool, thread post, memory, notification, reminder, publish again

This task implements Decisions "Approval" and "Summaries reach people".

`calls/publish.ts`:
- `callNotesExecutor: Executor` and `approverRule`, which looks up `invited_by` through `args.notes_id`.
- `onFinalNotes(notes)`:
  1. Ensure the inviter's DM with Scribe exists (T1's agent-DM path).
  2. `requestApproval(...)` per Decisions, with `ttlMs: 24 * 60 * 60 * 1000`.
  3. Set the notes to `pending_approval` with `approval_id` and `approval_requested_at`.
  - A `GateResult` with status `error` → `not_published` + the "not published" DM.
- `sweep(now)`:
  - The 20 h reminder: once, guarded by `reminded_at`.
  - Expiry detection: the approval is `expired` or `denied` while the notes are `pending_approval` → `not_published` + DM, through the guarded update.
- `republish(notesId, userId)`.

`calls/notes-routes.ts`: `POST /api/calls/notes/:notesId/republish` → `200 {approval_id}`; `403 notes_private` for anyone but the inviter; `409 not_republishable` for the wrong state or more than 7 days after the call.

`plugins/calls.ts`, in `init`:
- `registerGatedTool("call_notes_publish", {executor: callNotesExecutor, approverRule, defaultTtlMs: 24 * 60 * 60 * 1000})`.
- Mount `notes-routes.ts`.
- Pass `onFinalNotes` to the scheduler.
- Start the 60 s sweep, cleared in `stop`.

Tests — `services/bridge/test/call-publish.test.ts` (pglite; the real approvals service with the echo host, memory through `setMemoryForTests`):
- Final notes → exactly one approval. Its approver is the inviter (not the chat owner), it sits in the inviter's DM with Scribe and it expires in 24 h. No `approval_public` reaches the call's chat members.
- Approve with edited text →
  - one post as Scribe, with `reply_to` = the anchor and `meta.meeting.action_items` taken from the edited text;
  - one ingest `{namespace: chat:<id>, kind: meeting, source.type: meeting}`;
  - `call.notes_published` to every active human member.
- A decision by anyone but the inviter is refused.
- Deny → nothing posted or ingested, the notes become `not_published`, and exactly one DM with `state: not_published` goes out.
- Expiry found by the sweep → the same outcome, once.
- The reminder goes out once at 20 h, and not again after a simulated restart (a fresh sweep over the same rows).
- Republish works for the inviter only and only from `not_published`, creating a new pending approval; a second click → 409.
- Scribe removed before approval → failed, no post.
- A failed ingest keeps the post.

### T8: `meeting_transcript` tool through the registry, Scribe template

- `services/bridge/src/calls/transcript.ts`: `meetingTranscript(db, ctx: ToolCtx, args)` per Decisions "`meeting_transcript`" with the same limits. It computes speakers (display names of segment authors) and `not_captured` (participants without an `accepted` consent) with its own SQL, so it does not depend on T5's modules. Decliners are never named.
- `services/bridge/src/plugins/meeting-tools.ts` (`export const plugin: BridgePlugin`, name `meeting-tools`): `init` calls `registerTools(["scribe"], [{ name: "meeting_transcript", description: "Notes of a call held in this chat (published notes only). In your DM with the person who invited you, also their drafts and the transcript. Cite lines as [mm:ss Name].", properties: { call_id: { type: "string" }, query: { type: "string", maxLength: 200 } }, run }])`. `run` returns JSON text and caps strings with the same guards as the built-in tools.
- `infra/hermes/templates/scribe.md`: **append** one paragraph and leave the existing lines alone: `For questions about a call ("what did we decide in the call?"), call meeting_transcript first and answer from it. Cite time stamps like [03:41 Ana]. If it returns no_call_notes_here, say the call notes were not shared in this chat.`
- Do not edit `packages/protocol/src/roster.ts` or `services/bridge/src/mcp/server.ts`. The protected `services/bridge/test/mcp.test.ts` is the one exception (Global Constraints): only if it asserts Scribe's exact tool list, update that single expectation to include `meeting_transcript` and record it in the ledger. Otherwise leave it.

Tests — `services/bridge/test/mcp-meeting.test.ts` (pglite + seeded call rows, through `invokeTool`):
- In chat C, Scribe gets the published notes and action items with **no** `transcript` key; an unpublished call in C is not returned.
- A call from chat D is never returned in C, even with its `call_id`.
- In the inviter's DM with Scribe it returns drafts with `published:false` plus the transcript, and `query: "delivery"` returns the matching line with context within 60 lines.
- In another user's DM with Scribe → `no_call_notes_here`.
- `registeredTools("ops")` does not include the tool.

### T9: Notetaker worker (Python) with a fake SFU

All modules live in `services/meeting-agent/src/sa_meeting/`. Nothing at import time may need `livekit`; import it lazily inside `LiveKitRoom` and `SileroSegmenter`.

- `config.py`: `WorkerConfig` (pydantic) holds `bridge_url`, `notetaker_id`, `livekit_url`, `audio_url`, `stt_language` (default `en`) and the secrets `lk_token`, `meeting_token`, `audio_token`, `media_key: str | None`. It also has `poll_s = 2.0`, `min_segment_ms = 600`, `max_segment_ms = 20_000`, `preroll_ms = 200` and `silence_ms = 500`. `load(env, stdin_line)` builds it, with secrets only from the stdin JSON.
- `segmenter.py`:
  - `Segment(t0_ms: int, t1_ms: int, pcm: np.ndarray /* int16, 16 kHz mono */)`.
  - `EnergySegmenter(cfg)` consumes `Frame(ts_ms, pcm)` (10 ms or 20 ms). Speech is frame RMS > 0.01 of full scale. A segment starts after ≥ 100 ms of speech, includes the 200 ms pre-roll, ends after 500 ms of silence, is cut at 20 s, and is dropped when < 600 ms.
  - `SileroSegmenter(cfg)` (live extra): `livekit.plugins.silero.VAD.load(min_silence_duration=0.5, min_speech_duration=0.1)` stream, mapping `END_OF_SPEECH` frames to a `Segment` with the same drop/cut rules.
  - Both expose `async def segments(frames: AsyncIterator[Frame]) -> AsyncIterator[Segment]`.
- `stt.py`: `SttClient(audio_url, token, language, client: httpx.AsyncClient)`. `transcribe(seg) -> (text, lang)` POSTs a 16 kHz mono WAV (stdlib `wave`) to `/v1/audio/transcriptions` with `X-Internal-Token`. `is_noise(text)` drops empty text, `[BLANK_AUDIO]`, `(silence)`, `Thank you.`, `you` and `.` (case-insensitive, stripped).
- `bridge_client.py`: `BridgeClient` with `state() -> (status, set[str])`, `post_segment(speaker, t0_ms, t1_ms, text, lang) -> int` (returns the HTTP status; 403/409 are not errors) and `report(state, detail=None)`.
- `room.py`:
  - `class Room(Protocol)` has `async connect(url, token, e2ee_key: bytes | None)`, `participants() -> set[str]`, `async set_subscribed(identity: str, on: bool)`, `tracks() -> AsyncIterator[tuple[str, AsyncIterator[Frame]]]` (yields each newly subscribed audio track with its participant identity) and `async disconnect()`.
  - `LiveKitRoom` uses `rtc.Room()` with `auto_subscribe=False`. On `track_published` for `user:*`, it subscribes only when told to. It reads `rtc.AudioStream(track, sample_rate=16000, num_channels=1)`, maps frames to `Frame`, and sets `rtc.E2EEOptions` with a shared key when `e2ee_key` is set.
- `worker.py`: `async def run(cfg, room, make_segmenter, stt, bridge, clock=time.time) -> int`.
  - Connect, `report("joined")`.
  - Poll every `poll_s`: `status, allowed = bridge.state()`. Subscribe exactly the participants in `allowed`, and unsubscribe the others (this also covers a person who changes to declined). When status ≠ `active`, disconnect, `report("left")` and return 0.
  - Per track: segmenter → one shared `asyncio.Queue` → a single STT consumer (sequential) → `post_segment(identity, …)`, unless `is_noise`. Segment times are epoch ms (track start + frame offsets).
  - Exceptions → `report("error", str(type))` and return 1.
  - Never log transcript text.
- `synth.py` (live smoke helper): `sa-meeting synth --url URL --token-stdin --wav FILE [--delay-s N]` joins, publishes a microphone track from the WAV in real time (10 ms frames), then leaves.
- `main.py`: subcommands `join` (reads the stdin JSON line, `asyncio.run(run(...))` with `LiveKitRoom` + `SileroSegmenter` + real clients, and `sys.exit` with its code) and `synth`.

Tests (pytest, no LiveKit, no models). `services/meeting-agent/tests/fakes.py` provides `FakeRoom`: scripted participants each with a list of frames, which records subscriptions and connect args. The STT and bridge fakes use `httpx.MockTransport`. Synthetic tracks are 16 kHz sine bursts with silence between them.
- `test_segmenter.py`:
  - Speech 1.0 s / silence 1.0 s / speech 0.4 s → one segment (the 0.4 s one is dropped).
  - 25 s of continuous speech → two segments (20 s + 5 s).
  - The pre-roll is included.
- `test_worker.py`:
  - **Two synthetic tracks → two speakers**: `user:ana` and `user:vlad` both consented, so the bridge receives segments with both identities in time order and the STT is called once per segment.
  - `user:rares` is not in `allowed`: never subscribed, zero STT calls, zero posts.
  - `user:vlad` becomes allowed at poll 2: only his speech after that is posted.
  - Status `stopped` → disconnect and `report("left")`, exit 0.
  - A noise text is not posted.
  - `media_key` from stdin reaches `FakeRoom.connect(e2ee_key=…)`, and it is absent from the environment the test passes.

### T10: Web voice — push-to-talk, voice bubble, transcript, player, latency HUD

New files only, in `apps/web/src/voice/`. The donna primitives come from `apps/web/src/ds/` and the VIBE rules apply: the brand colour (teal) is for the mic button and AI surfaces only.
- `recorder.ts`: `startRecording({maxMs = 60_000, onAutoStop}) → {stop(): Promise<{bytes, mime, durationMs} | null>, cancel()}` on `MediaRecorder`. It picks the first supported mime of `audio/webm;codecs=opus` and `audio/mp4`. A recording < 500 ms returns `null`. `getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}})`. Tracks are always stopped.
- `PushToTalk.tsx`: a 44 px round button, `aria-label="Hold to talk"`, from the mockup.
  - `pointerdown` starts and `pointerup` sends. `pointerleave` or Esc cancels.
  - While recording it shows a timer `0:07` and a red dot, and "Release to send · Esc to cancel".
  - "Too short" toast; mic permission denied → "Microphone access is blocked for this site."
  - Props: `onSend(rec)`, `disabled`.
- `latency.ts`: `markSent(sourceId, releasedAt)` and `firstAudio(sourceId, now) → voiceToVoiceMs | null` (each source counted once, entries dropped after 2 min).
- `voiceStream.ts`: `VoicePlayer` plays `voice.chunk` WAVs for one `source_id` in `seq` order through one `AudioContext`. A late lower seq is dropped. `stopAll()` is called when the user starts a new recording.
- `VoiceMessage.tsx`: the voice bubble, with a play/pause button, duration, a waveform-less progress bar and `aria-label="voice message"`. It decrypts through the existing download path given as a prop `load(): Promise<Blob>`. Below it, "Transcript · on this Mac" plus the text when a transcript message exists.
- `LatencyHud.tsx`: the pill `voice to voice 1.8 s` (one decimal; ≥ 10 s shows whole seconds). Click opens a popover: `transcribe 0.4 s · first words 0.9 s · first audio 1.3 s · total 3.2 s` from `VoiceLatency`, with absent stages left out.

Tests (vitest + Testing Library, fake `MediaRecorder`/`getUserMedia`/`AudioContext`):
- `apps/web/test/voice-recorder.test.ts`: auto-stop at 60 s → `onAutoStop` with ≤ 60 000 ms; a 300 ms hold → `null`; tracks are stopped after `cancel`.
- `apps/web/test/voice-ptt.test.tsx`: hold → release calls `onSend` once; Esc while holding sends nothing; denied permission shows the message.
- `apps/web/test/voice-stream.test.ts`: chunks 1, 0, 2 play as 0, 1, 2 (1 is queued until 0 arrives); `firstAudio` returns a value once per source.
- `apps/web/test/voice-hud.test.tsx`: 1830 ms → `voice to voice 1.8 s`; the popover omits a missing `first_audio_ms`.

### T11: Web call page, consent banner, notetaker panel, call card

New files only, in `apps/web/src/call/`. Layout, spacing and copy follow `docs/design/mockups/Call.dc.html`, with the notetaker named after the agent (Scribe) and the inviter.
- `media.ts`: `connectMedia({url, token, e2eeKey?}) → MediaSession` (`mute(on)`, `leave()`, `onActiveSpeakers(cb)`, `onState(cb: "connecting"|"connected"|"failed")`). It wraps `livekit-client` `Room` (`adaptiveStream:false`, `dynacast:false`), enables the microphone and attaches remote audio tracks to hidden `<audio>` elements. With `e2eeKey`: `ExternalE2EEKeyProvider` + `new Worker(new URL("livekit-client/e2ee-worker", import.meta.url))`, `setKey`, `setE2EEEnabled(true)`. It is imported dynamically by `CallPage` so tests can mock it.
- `useCall.ts`: loads `CallInfo`, segments and (for the inviter) notes; subscribes with `onBridgeEvent` to `call.updated`/`call.segment`/`call.notes` for this call; exposes the actions from `callApi`.
  - On mount it calls `token()`: `available:false` → media off banner, else `connectMedia`.
  - On unmount and `pagehide` it calls `leave` with `fetch(..., {keepalive: true})` and the auth header (no `sendBeacon`, which cannot send the header).
  - "Add notetaker": if Scribe is not a chat member, run the T1 workspace-agent add helper from `apps/web/src/state/membership.ts` first, then `invite(callId, mediaKey)` with the media key read from the anchor message's `meta.call`.
- `CallPage.tsx`: route component for `/c/:chatId/call/:callId`.
  - Header: `← # <chat>`, `Call · mm:ss`, the pill `Call server runs on this Mac`, `You are <name>`. With `e2ee=false` the pill tooltip says "audio is encrypted to this Mac, not end to end yet".
  - Participant list, then notetaker tile, live capture, consent footer and the buttons `Add notetaker` (only when none is active), `Stop notes` (when active), `Mute`/`Unmute`, `Leave`, `End call` (starter).
  - The media-off banner per Decisions.
- `ConsentBanner.tsx`: shown to a participant whose consent is `pending`: "<Inviter> invited Scribe to take notes. Scribe transcribes only people who accept, on this Mac. Notes go to <Inviter> first and reach the chat only if <Inviter> approves." Buttons `Accept` / `Decline`. After an answer it collapses to a chip, "You are captured" or "You are not captured", with a `Change` link.
- `ParticipantList.tsx`: rows `Ana · speaking`, `Vlad · you`, plus a capture state per person, `captured` / `not captured` / `waiting for answer`, and `muted` when known.
- `NotetakerPanel.tsx`:
  - Tile `Scribe · taking notes · invited by Ana` with "Listens to each person's own audio, so every line has a speaker. No camera, no voice."
  - "What Scribe is capturing" / "Everyone in the call sees this. Transcribed on this Mac." with lines `who · mm:ss` + text, auto-scrolled.
  - After stop: "<Name> stopped the notes." Failed: "The notetaker stopped unexpectedly. What it captured is kept for <Inviter>."
  - Footer: "Consent: Ana invited 14:11 · Vlad accepted · Rareș declined. Anyone in the call can stop the notes."
- `NotesDraft.tsx` (inviter only): "Notes so far · only you see this", the markdown via `react-markdown`, and when final, "Final notes are waiting for your approval" with a link to the approvals view; or "Nothing was captured."
- `CallCard.tsx`: renders a text message with `meta.call`. Started: "<Name> started a call · N in call" + `Join`, which navigates to the call page and is disabled when the call has ended. Ended: "Call ended · N min".

Tests (vitest, `media.ts` mocked, events dispatched with `dispatchBridgeEvent`):
- `apps/web/test/call-consent.test.tsx`: a pending participant sees the banner with the inviter's name; Accept calls `consent("accepted")` and shows "You are captured"; the inviter never sees the banner.
- `apps/web/test/call-page.test.tsx`:
  - `available:false` shows the media-off banner and still renders consent and the capture lines.
  - A `call.segment` event appends `Vlad · 00:05`.
  - `Stop notes` is visible to a non-inviter and calls `stop`.
  - `NotesDraft` renders only for the inviter.
- `apps/web/test/call-card.test.tsx`: started vs ended rendering; `Join` is disabled when ended.

### T12: Web wiring — composer, messages, channel header, routes, events, notes notifications

The only task that edits T1 or memory-plan web files.
- `apps/web/src/composer/Composer.tsx`: `PushToTalk` next to Send when the composer is empty. `onSend` → `engine.sendFile(chat, {name:"voice-<ts>.webm"|".m4a", mime, bytes}, {voice:{duration_ms}, replyTo})`, then `latency.markSent(id, releasedAt)`. It starts the `VoicePlayer` for that source id.
- `apps/web/src/channel/MessageItem.tsx`:
  - A file with `voice` renders `VoiceMessage`, with the transcript text found via `meta.transcript_of`.
  - Hide text messages that have `transcript_of` and file messages referenced by any `meta.audio_id`.
  - A text with `meta.call` renders `CallCard`.
- `apps/web/src/channel/AgentMessage.tsx`: when `meta.audio_id` is set, render a `VoiceMessage` player for that file above the text, and a `LatencyHud` when `meta.latency` is set and the viewer is the requester.
- `apps/web/src/channel/ChannelHeader.tsx`: a `Start call` button (phone icon) → `callApi.start` → when new, generate a 32-byte base64url media key and send the text "<Name> started a call." with `meta.call {call_id, op:"started", media_key}` → `callApi.anchor` → navigate to the call route. If the call exists, navigate only.
- `apps/web/src/app/routes.tsx`: route `/c/:chatId/call/:callId` → `CallPage` (inside the login gate, outside the right rail).
- `apps/web/src/approvals/store.tsx` (the memory plan's `ApprovalsProvider`, the only `openEvents` caller): forward `call.*`, `voice.*` and `latency.*` events to `dispatchBridgeEvent`, and leave the approval handling unchanged. The composer wiring feeds the `VoicePlayer` and `latency.firstAudio` from `voice.chunk` via `onBridgeEvent`.
- `apps/web/src/state/session.ts`: on `call.notes_published`, mark that chat unread with a mention (the same flag an @mention sets) and show the toast `Notes from <title> are ready`, whose `Open` goes to `/c/:chatId/t/:anchor`.
- `apps/web/src/channel/AgentMessage.tsx`, also for `meta.call_notes`:
  - `Review notes` (state `pending`) opens the approvals view.
  - `Publish notes again` (state `not_published`) calls `callApi.republish(notes_id)`, then shows "Sent for your approval again."
  - `ApprovalCard` needs no change (generic preview).

Test — `apps/web/test/voice-wiring.test.tsx`:
- A transcript message is not rendered as its own row but under its voice bubble.
- An agent reply with `audio_id` shows one player and hides the file row.
- `Start call` sends one `meta.call` message and calls `anchor` with its id.
- A `call.notes_published` event marks the chat with a mention and shows the toast, and `Publish notes again` calls `republish`.

### T13: E2E offline — voice and the consent flow without LiveKit

- `e2e/stubs/audio-stub.ts`: a Node http server on 127.0.0.1:8665.
  - `GET /healthz`.
  - `POST /v1/audio/transcriptions` checks `X-Internal-Token: e2e-audio` and returns `{text:"What is on the agenda today?", language:"en", duration:1.5, segments:[]}`.
  - `POST /v1/audio/speech` returns a generated 300 ms 24 kHz silent PCM16 WAV.
- `e2e/start-bridge.sh` exports `AUDIO_URL=http://127.0.0.1:8665`, `AUDIO_TOKEN=e2e-audio`, `MEETING_TOKEN=e2e-meeting`, `SA_NOTETAKER=fake`, `SA_NOTES_INTERVAL_MS=600000`, `LIVEKIT_URL=ws://127.0.0.1:9` (always down) and `LIVEKIT_API_SECRET=e2e-livekit-secret-0123456789abcdef0123456789`.
- `e2e/playwright.config.ts`: add the stub as a webServer (`pnpm --filter @sa/e2e exec tsx stubs/audio-stub.ts`, url `/healthz`). Chromium `launchOptions.args`: `--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`.
- `e2e/tests/voice.spec.ts` (echo runtime):
  - Ana opens her DM with Scribe and holds the mic button 1.5 s.
  - Her voice bubble appears with a duration.
  - Then "Transcript · on this Mac" with "What is on the agenda today?".
  - Then Scribe's thread reply with a player (an `audio` element whose source decrypts) and the pill matching `/voice to voice \d/`.
- `e2e/tests/call.spec.ts`: three browser contexts (Ana, Vlad, Rareș) in a new group with Scribe added.
  1. Ana starts a call. The call card appears for Vlad and Rareș, who join. All three see the media-off banner.
  2. Ana clicks `Add notetaker`. Vlad and Rareș see the banner naming Ana. Vlad accepts and Rareș declines. The lists show Ana and Vlad `captured`, Rareș `not captured`.
  3. The test posts segments to `/internal/calls/notetakers/:id/segments` with `X-Internal-Token: e2e-meeting`, using the notetaker id from `GET /api/calls/:id`. One from `user:vlad` ("We move delivery to the 20th of March.") → 201, and the line shows on all three pages. One from `user:rares` → 403, and it shows nowhere.
  4. Vlad's `GET /api/calls/:id/notes` → 403.
  5. Rareș clicks `Stop notes`. Everyone sees "Rareș stopped the notes."
  6. Ana sees the approval card "Post call notes in #<chat>", and Vlad sees no card. Ana approves.
  7. All three see Scribe's "Call notes" reply in the call's thread with "Not captured: 1 person who did not consent" and without Rareș's sentence. Vlad and Rareș get the toast "Notes from … are ready" and a mention on the group.
  - A third test: Ana denies, her DM with Scribe shows `Publish notes again`, and clicking it brings back a new approval card.
  - A second test: all three accept, and all show `captured`. Leaving with all three, then waiting, ends the call after the grace period (`start-bridge.sh` sets `SA_CALL_GRACE_MS=2000`, which T5's timer reads).

### T14: Live — voice latency and the LiveKit call smoke (alone)

Runs alone. Free ports like T1's T21 if a manual preview holds them. Start the stack with `make up`, then `make dev` in the background (logs in `.run/t14-dev.log`). Wait for `/api/healthz`, `/relay/healthz`, audio-api `/healthz` and the roster gateways.
- `e2e/live/voice-fixtures.sh` (new): with `espeak-ng -v en-us -s 150 -w` and `ffmpeg`, write to `.run/fixtures/`:
  - `ask.webm` (Opus 24 k) for "Ops, how healthy is the cluster right now?";
  - `ana.wav`, `vlad.wav` and `rares.wav` (16 kHz mono, 2 s leading silence) for "We agreed to move the delivery to the twentieth of March.", "I will send the confirmation email by Friday." and "The secret budget is ninety thousand euros.".
- `e2e/live/voice-smoke.ts`: as Ana with a Node device (as in agents-smoke), in a DM with Ops (create it through the API the web uses), send `ask.webm` as a voice file, three times (the first is a warm-up). For each run, within 120 s:
  - a transcript (`transcript_of`) containing `cluster`;
  - a reply with `meta.audio_id` + `meta.latency`, whose file decrypts to a WAV longer than 0.5 s.
  Print `stt / first token / first audio / total` per run and `first_audio_ms < 2000 on fast: PASS|MISS`; a miss is reported, not failed. Fail only on missing transcript, reply or audio.
- `e2e/live/call-smoke.ts`: if `livekit-server` is not on PATH, print `SKIPPED: livekit-server is not installed (human step: brew install livekit)` and exit 0. Otherwise:
  1. `bash infra/scripts/livekit.sh start`. The bridge in `make dev` runs with `SA_NOTETAKER=worker`.
  2. Ana creates a group with Vlad, Rareș and Scribe, starts a call and sets the anchor. All three get tokens.
  3. Ana invites the notetaker. Vlad accepts, Rareș declines.
  4. Start three `uv run sa-meeting synth` processes (tokens on stdin) publishing the fixtures.
  5. Within 120 s: ≥ 2 segments from exactly the speakers `{ana, vlad}`, texts containing `delivery` and `email`, and no segment containing `ninety` or `budget`.
  6. Ana ends the call. Within 240 s a pending approval for Ana; approve it through the approvals API. Within 30 s Scribe's thread reply with `meta.meeting`.
  7. Ana asks "@Scribe what did we decide in the call?". The reply's tools include `meeting_transcript` and the text mentions `March` or `delivery`.
  8. Chat voice during a call: run one voice-smoke round while the synth tracks play and print its latency.
  9. Stop LiveKit.
- Memory headroom as in T1's T21 (gateway RSS, `vm.swapusage`, compressor), sampled before, during the call and at the end, with the same thresholds. Report every number, both smokes' outcomes (PASS / MISS / SKIPPED) and the worker log lines (`.run/notetakers/*.log`, ids and counts only). `make down` at the end.

```relay-plan
{
  "slug": "sa-voice-meetings",
  "suite": "make check",
  "setup": "pnpm install --frozen-lockfile && uv sync",
  "tasks": [
    {
      "id": "T1",
      "title": "Protocol, migration, engine message ids, host API and event ports",
      "tier": "cheap",
      "code": "complete",
      "risk": "medium",
      "files": [
        "packages/protocol/src/index.ts",
        "packages/protocol/test/voice-calls.test.ts",
        "packages/client/src/engine.ts",
        "packages/client/test/engine-ids.test.ts",
        "services/bridge/src/migrations/006_calls.sql",
        "services/bridge/src/agents/api.ts",
        "apps/web/src/lib/bridge-events.ts",
        "apps/web/src/call/api.ts"
      ],
      "deps": [],
      "behaviors": [
        "voice messages carry a duration of at most 60 s",
        "replies carry latency, audio and transcript links; call markers and meeting action items have fixed shapes",
        "engine sends resolve the new message id",
        "the server event stream carries call and voice events next to approvals"
      ],
      "tests": 4,
      "done": "pnpm --filter @sa/protocol test && pnpm --filter @sa/client test && pnpm -r --if-present run typecheck"
    },
    {
      "id": "T2",
      "title": "Dependencies, LiveKit config and scripts, worker package skeleton, Make targets",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "services/bridge/package.json",
        "apps/web/package.json",
        "e2e/package.json",
        "pnpm-lock.yaml",
        "pyproject.toml",
        "uv.lock",
        "services/meeting-agent/pyproject.toml",
        "services/meeting-agent/src/sa_meeting/__init__.py",
        "services/meeting-agent/src/sa_meeting/main.py",
        "infra/livekit.yaml",
        "infra/scripts/livekit.sh",
        "infra/scripts/secrets.sh",
        "infra/scripts/dev.sh",
        "infra/scripts/demo.sh",
        "infra/scripts/up.sh",
        "infra/scripts/down.sh",
        "infra/scripts/prereqs.sh",
        ".env.example",
        "README.md",
        "Makefile"
      ],
      "deps": [],
      "behaviors": [
        "make dev and make demo start LiveKit when installed and print a hint otherwise",
        "make call-smoke prints SKIPPED and exits 0 without livekit-server",
        "make up starts audio-api with its token"
      ],
      "tests": 0,
      "done": "pnpm install --frozen-lockfile && uv sync && uv run python -c 'import sa_meeting' && bash -n infra/scripts/livekit.sh && make -n call-smoke && pnpm --filter @sa/bridge typecheck"
    },
    {
      "id": "T3",
      "title": "Bridge voice pipeline modules: audio client, sentences, WAV, speaker",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "services/bridge/src/voice/audio-client.ts",
        "services/bridge/src/voice/sentences.ts",
        "services/bridge/src/voice/wav.ts",
        "services/bridge/src/voice/voice-turn.ts",
        "services/bridge/test/voice-sentences.test.ts",
        "services/bridge/test/voice-wav.test.ts",
        "services/bridge/test/voice-turn.test.ts"
      ],
      "deps": [
        "T1"
      ],
      "behaviors": [
        "streamed reply text is spoken sentence by sentence in order",
        "spoken audio is capped at 600 characters and a failed sentence is skipped",
        "per-sentence WAVs join into one voice reply"
      ],
      "tests": 3,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/voice-sentences.test.ts test/voice-wav.test.ts test/voice-turn.test.ts"
    },
    {
      "id": "T4",
      "title": "Agent host: voice turns, sendAs, complete",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "services/bridge/src/agents/host.ts",
        "services/bridge/src/agents/voice-trigger.ts",
        "services/bridge/test/voice-host.test.ts",
        "services/bridge/test/host-send.test.ts"
      ],
      "deps": [
        "T3"
      ],
      "behaviors": [
        "a voice message is transcribed once and answered by at most one agent, by voice",
        "the requester receives streamed audio and a latency sample; others do not",
        "agent voice messages never trigger; a failed transcription gets a visible reply; a stopped turn sends no audio",
        "background completions for call notes wait behind human turns and never force a tool"
      ],
      "tests": 4,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/voice-host.test.ts test/host-send.test.ts"
    },
    {
      "id": "T5",
      "title": "Calls API: store, tokens, consent, routes, webhook, plugin",
      "tier": "mid",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/bridge/src/calls/store.ts",
        "services/bridge/src/calls/consent.ts",
        "services/bridge/src/calls/tokens.ts",
        "services/bridge/src/calls/livekit-health.ts",
        "services/bridge/src/calls/routes.ts",
        "services/bridge/src/calls/webhook.ts",
        "services/bridge/src/plugins/calls.ts",
        "services/bridge/test/call-tokens.test.ts",
        "services/bridge/test/call-consent.test.ts",
        "services/bridge/test/call-routes.test.ts"
      ],
      "deps": [
        "T1",
        "T2"
      ],
      "behaviors": [
        "any chat member starts or joins the chat's single active call",
        "the notetaker token cannot publish (D-4)",
        "each participant accepts or declines; the inviter always consents",
        "anyone in the call can stop the notes",
        "only the inviter can read the notes",
        "calls work without a call server and report audio as unavailable",
        "LiveKit webhooks are signature-checked",
        "a non-member is refused on every call route",
        "a second invite while one is active is refused"
      ],
      "tests": 9,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/call-tokens.test.ts test/call-consent.test.ts test/call-routes.test.ts"
    },
    {
      "id": "T6",
      "title": "Notetaker supervisor, internal worker routes, summaries",
      "tier": "mid",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/bridge/src/calls/notetaker.ts",
        "services/bridge/src/calls/internal-routes.ts",
        "services/bridge/src/calls/summary.ts",
        "services/bridge/src/calls/scheduler.ts",
        "services/bridge/src/plugins/calls.ts",
        "services/bridge/test/call-summary.test.ts",
        "services/bridge/test/call-internal.test.ts",
        "services/bridge/test/call-notetaker.test.ts"
      ],
      "deps": [
        "T5"
      ],
      "behaviors": [
        "segments from anyone who has not accepted are rejected",
        "live capture lines reach only people in the call",
        "interim notes every 5 minutes and one final summary reach only the inviter",
        "a failed model still yields notes",
        "secrets reach the worker only on stdin; no worker survives a restart",
        "action items are parsed from the notes",
        "accepted-then-left or agent speakers are rejected too",
        "stop, end and worker exit racing yield exactly one final summary",
        "long transcripts are summarised in parts and merged",
        "a worker crash marks the notes failed and still summarises"
      ],
      "tests": 10,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/call-summary.test.ts test/call-internal.test.ts test/call-notetaker.test.ts"
    },
    {
      "id": "T7",
      "title": "Publish notes: gated tool, thread post, memory, notification, reminder, publish again",
      "tier": "mid",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/bridge/src/calls/publish.ts",
        "services/bridge/src/calls/notes-routes.ts",
        "services/bridge/src/plugins/calls.ts",
        "services/bridge/test/call-publish.test.ts"
      ],
      "deps": [
        "T6"
      ],
      "behaviors": [
        "final notes become one 24 h approval for the inviter in the inviter's DM with Scribe (D-3)",
        "approved notes post in the call thread with action items and enter chat memory as kind=meeting",
        "every chat member gets a notes-ready mention when notes are published",
        "denied or expired notes are never posted or ingested, and the inviter can publish them again",
        "the inviter gets one reminder before the approval expires",
        "only the inviter can decide or republish",
        "edited notes are what gets posted",
        "notes are not posted when Scribe left the chat",
        "a failed memory ingest keeps the post"
      ],
      "tests": 9,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/call-publish.test.ts"
    },
    {
      "id": "T8",
      "title": "meeting_transcript tool through the registry, Scribe template",
      "tier": "mid",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/bridge/src/calls/transcript.ts",
        "services/bridge/src/plugins/meeting-tools.ts",
        "infra/hermes/templates/scribe.md",
        "services/bridge/test/mcp-meeting.test.ts",
        "services/bridge/test/mcp.test.ts"
      ],
      "deps": [
        "T1"
      ],
      "behaviors": [
        "@Scribe answers from published call notes and action items in the call's chat",
        "the verbatim transcript is returned only to the inviter in their DM with Scribe",
        "drafts are visible only in the inviter's DM",
        "other chats' calls and other agents are refused",
        "a keyword query returns matching lines with context"
      ],
      "tests": 5,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/mcp-meeting.test.ts test/mcp.test.ts"
    },
    {
      "id": "T9",
      "title": "Notetaker worker (Python) with a fake SFU",
      "tier": "mid",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/meeting-agent/src/sa_meeting/config.py",
        "services/meeting-agent/src/sa_meeting/segmenter.py",
        "services/meeting-agent/src/sa_meeting/stt.py",
        "services/meeting-agent/src/sa_meeting/bridge_client.py",
        "services/meeting-agent/src/sa_meeting/room.py",
        "services/meeting-agent/src/sa_meeting/worker.py",
        "services/meeting-agent/src/sa_meeting/synth.py",
        "services/meeting-agent/src/sa_meeting/main.py",
        "services/meeting-agent/tests/fakes.py",
        "services/meeting-agent/tests/test_segmenter.py",
        "services/meeting-agent/tests/test_worker.py"
      ],
      "deps": [
        "T2"
      ],
      "behaviors": [
        "two synthetic tracks yield segments attributed to two speakers",
        "people who have not accepted are never subscribed or transcribed",
        "consent changes take effect at the next poll",
        "segments under 0.6 s are dropped and over 20 s are cut",
        "the worker leaves when the notes stop",
        "noise transcripts are not posted",
        "the media key reaches the room only from stdin",
        "each segment is transcribed exactly once"
      ],
      "tests": 8,
      "done": "uv run ruff check services/meeting-agent && uv run pytest services/meeting-agent/tests"
    },
    {
      "id": "T10",
      "title": "Web voice: push-to-talk, voice bubble, transcript, player, latency HUD",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "apps/web/src/voice/recorder.ts",
        "apps/web/src/voice/PushToTalk.tsx",
        "apps/web/src/voice/latency.ts",
        "apps/web/src/voice/voiceStream.ts",
        "apps/web/src/voice/VoiceMessage.tsx",
        "apps/web/src/voice/LatencyHud.tsx",
        "apps/web/test/voice-recorder.test.ts",
        "apps/web/test/voice-ptt.test.tsx",
        "apps/web/test/voice-stream.test.ts",
        "apps/web/test/voice-hud.test.tsx"
      ],
      "deps": [
        "T1"
      ],
      "behaviors": [
        "hold to record up to 60 s, release to send, Esc to cancel",
        "streamed reply audio plays in order",
        "the latency HUD shows voice to voice and per-stage timings",
        "a recording under 0.5 s is discarded"
      ],
      "tests": 4,
      "done": "pnpm --filter @sa/web typecheck && pnpm --filter @sa/web exec vitest run test/voice-recorder.test.ts test/voice-ptt.test.tsx test/voice-stream.test.ts test/voice-hud.test.tsx"
    },
    {
      "id": "T11",
      "title": "Web call page, consent banner, notetaker panel, call card",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "apps/web/src/call/media.ts",
        "apps/web/src/call/useCall.ts",
        "apps/web/src/call/CallPage.tsx",
        "apps/web/src/call/ConsentBanner.tsx",
        "apps/web/src/call/ParticipantList.tsx",
        "apps/web/src/call/NotetakerPanel.tsx",
        "apps/web/src/call/NotesDraft.tsx",
        "apps/web/src/call/CallCard.tsx",
        "apps/web/test/call-consent.test.tsx",
        "apps/web/test/call-page.test.tsx",
        "apps/web/test/call-card.test.tsx"
      ],
      "deps": [
        "T1",
        "T2"
      ],
      "behaviors": [
        "participants see who invited the notetaker and accept or decline",
        "everyone in the call sees what is captured and who is not captured",
        "anyone in the call can stop the notes",
        "only the inviter sees the notes draft",
        "the page works with the call server down"
      ],
      "tests": 5,
      "done": "pnpm --filter @sa/web typecheck && pnpm --filter @sa/web exec vitest run test/call-consent.test.tsx test/call-page.test.tsx test/call-card.test.tsx"
    },
    {
      "id": "T12",
      "title": "Web wiring: composer, messages, channel header, routes, events, notes notifications",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "apps/web/src/composer/Composer.tsx",
        "apps/web/src/channel/MessageItem.tsx",
        "apps/web/src/channel/AgentMessage.tsx",
        "apps/web/src/channel/ChannelHeader.tsx",
        "apps/web/src/app/routes.tsx",
        "apps/web/src/approvals/store.tsx",
        "apps/web/src/state/session.ts",
        "apps/web/test/voice-wiring.test.tsx"
      ],
      "deps": [
        "T10",
        "T11"
      ],
      "behaviors": [
        "transcripts show under their voice message, and agent voice replies show one player",
        "Start call posts one call card that anchors the call thread",
        "published notes show as a mention with a notes-ready toast",
        "the inviter can review pending notes or publish them again from the DM"
      ],
      "tests": 4,
      "done": "pnpm --filter @sa/web typecheck && pnpm --filter @sa/web test"
    },
    {
      "id": "T13",
      "title": "E2E offline: voice and the consent flow without LiveKit",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "e2e/stubs/audio-stub.ts",
        "e2e/start-bridge.sh",
        "e2e/playwright.config.ts",
        "e2e/tests/voice.spec.ts",
        "e2e/tests/call.spec.ts"
      ],
      "deps": [
        "T4",
        "T7",
        "T8",
        "T12"
      ],
      "behaviors": [
        "a held voice message gets a transcript and a spoken agent reply with a latency HUD",
        "a decliner is never captured and their segment is rejected",
        "notes stay private until the inviter approves, then appear in the call thread for everyone",
        "the call ends after everyone leaves",
        "a denied draft can be published again by the inviter"
      ],
      "tests": 4,
      "done": "pnpm --filter @sa/e2e exec playwright test tests/voice.spec.ts tests/call.spec.ts"
    },
    {
      "id": "T14",
      "title": "Live: voice latency and the LiveKit call smoke",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "e2e/live/voice-fixtures.sh",
        "e2e/live/voice-smoke.ts",
        "e2e/live/call-smoke.ts"
      ],
      "deps": [
        "T9",
        "T13"
      ],
      "behaviors": [
        "voice-to-voice latency on the local stack is measured and reported",
        "with LiveKit installed, two real speakers are captured and the decliner is not; without it the smoke reports SKIPPED"
      ],
      "tests": 0,
      "done": "bash e2e/live/voice-fixtures.sh && make voice-smoke && make call-smoke"
    }
  ]
}
```
