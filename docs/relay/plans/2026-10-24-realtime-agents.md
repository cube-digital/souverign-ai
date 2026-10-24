# Real-time Agent Activity Plan

**Goal:** chatting with an agent feels live. The agent is warm before the first question, everyone sees "<Agent> is thinking…" and "using <tool>…" while it works, and the answer streams in as it is written, all end-to-end encrypted.
**Spec:** docs/superpowers/specs/2026-10-24-sovereign-agents-demo-design.md (§5.2 F1, §9 transparency) + the SP2 code on main (`services/bridge/src/agents/*`, `packages/client/src/engine.ts`, `services/relay/src/server.ts`, `apps/web/src/chat/Conversation.tsx`).
**Architecture:** a new relay op `signal` carries **ephemeral** encrypted envelopes (kind `status`) that the relay forwards to the chat's other active members and never stores. The agent host sends `activity` bodies through it: `thinking` at the start of a turn, `tool` for each MCP call as it happens, `writing` with the draft so far (throttled while Hermes streams), and `done`/`error` at the end. The final reply stays a normal stored message. The web shows one live bubble per active agent until its final message arrives.

## Decisions

- Seen live: the first reply took 47 s, 36 s of it Hermes starting. **Pre-warm:** `AgentHost` calls `runtime.ensureStarted(agent)` in the background when an agent is added to a chat and, at bridge start, for every agent that has chats.
- **Streaming:** `AgentRuntime` gets `chatStream(agent, chatId, messages, onDelta)`. `HermesRuntime` uses `/v1/chat/completions` with `stream: true` (SSE `data:` lines, `[DONE]`); `onDelta(text)` gets content deltas. Reasoning deltas (`reasoning_content` or `reasoning`) are collected for the trace, not shown as draft. If streaming fails before the first delta, fall back to the non-streaming `chat` once.
- **Throttle:** at most one `writing` signal per 400 ms per agent, always carrying the whole draft so far (≤ 8000 chars), so a lost signal costs nothing.
- **Ephemeral means ephemeral:** the relay never writes `status` envelopes to SQLite, never acks them, and forwards them only to the chat's other active members' open sockets. Clients drop a live bubble 90 s after its last signal.
- **Encryption:** an activity body is encrypted with the chat's latest key and `messageAad(chat, epoch, id)`, like a message. A client without that key ignores it.

## Global Constraints

- SP2 conventions apply (TS `@sa/*`, NodeNext `.js` imports, Biome, commits `feat(agents): …`). No task changes a `package.json` or the lockfile.
- Public repo: no client company or product names anywhere; `git grep -inE "real[t]yme|gate[x]"` stays empty, commit messages included.
- No plaintext, drafts or tool results in logs.
- Only T6 may start real Hermes gateways or the LLM; it runs alone in the last wave.

## Review Focus

- Nothing of kind `status` ever reaches the relay's storage, and it is never delivered to non-members or back to the sender.
- The final stored reply is unchanged from SP2 (text, `meta.tools`, `meta.ms`, `meta.trace`); live signals are extra and safe to lose.
- Pre-warm never starts more gateways than agents with chats, and stays within ports 8701–8709.

## Tasks

### T1: Protocol for ephemeral activity

`packages/protocol/src/index.ts`:
- `Envelope.kind` becomes `z.enum(["msg", "key", "status"])`; the existing refine stays (`to_device` only for `key`).
- `ClientOp` gains `z.object({ op: z.literal("signal"), env: Envelope })`; `RelayOp` gains `z.object({ op: z.literal("signal"), env: Envelope })`.
- Add:

```ts
export const ActivityBody = z.object({
  type: z.literal("activity"),
  phase: z.enum(["thinking", "tool", "writing", "done", "error"]),
  tool: z.string().max(64).optional(),
  draft: z.string().max(8000).optional(),
});
export type ActivityBody = z.infer<typeof ActivityBody>;
```

Test (`packages/protocol/test/protocol.test.ts`, add one case): a `signal` op with a `status` envelope parses; a `status` envelope with `to_device` is rejected.

### T2: Relay forwards signals without storing them

`services/relay/src/server.ts`: on `signal`, the envelope kind must be `status`, the sender must be the hello device and an active member of the chat, else `error not_member` / `bad_request`. Forward `{op:"signal", env}` to every open socket of the chat's other active members. No insert, no ack, no seq. Log `{msg:"signal", chat_id, size}` at debug level only.

Tests (`services/relay/test/relay.test.ts`): a member's signal reaches the other member and not the sender, and the DB holds no new rows afterwards; a non-member's signal is refused.

### T3: Client engine: send and receive activity

`packages/client`: `RelayLink` gains `signal(env: Envelope): void` and `onSignal(cb: (env: Envelope) => void): () => void`. `RelayClient` implements them (signal is fire-and-forget; dropped if the socket is not open). `ChatEngine` gains `sendActivity(chatId: string, body: ActivityBody): Promise<void>` (latest epoch's key; no key → silently skip) and `onActivity(cb: (a: { chatId: string; senderDevice: string; body: ActivityBody; ts: number }) => void): () => void`. Incoming `status` envelopes are decrypted and parsed with `ActivityBody`; failures are ignored. They never touch the cursor or `onMessage`. `test/fake-relay.ts` gains signal forwarding.

Test (`packages/client/test/engine.test.ts`): an activity sent by one member is received, decrypted, by the other, and does not appear as a message.

### T4: Bridge: pre-warm, streaming turns, live activity

- `src/agents/runtime.ts`: add `chatStream(agent, chatId, messages, onDelta: (text: string) => void): Promise<{ content: string; reasoning?: string }>`.
- `src/agents/hermes.ts`: implement it with `stream: true` as in Decisions, with the non-streaming fallback.
- `src/agents/echo.ts`: `chatStream` emits its echo text word by word, 40 ms apart, so tests see drafts.
- `src/mcp/tool-log.ts`: emit an event per recorded call (`on("tool", (agentId, name) => …)`).
- `src/agents/host.ts`:
  - Pre-warm per Decisions.
  - In a turn, send `activity thinking` first. On each tool event for this agent, send `activity tool` with the name. Use `chatStream` with throttled `activity writing` drafts. Then send the final message exactly as today, followed by `activity done`; on failure, `activity error` plus the existing error message.

Tests (`services/bridge/test/host.test.ts`, echo runtime): a turn emits `thinking`, at least one `writing` with a growing draft, then the final message, then `done`, in that order; adding an agent to a chat triggers `ensureStarted` for it.

### T5: Web: live activity bubble

- `state/session.ts`: keep `activity: Record<chatId, Record<senderDevice, { body; ts }>>` from `engine.onActivity`. Clear an entry when that device's final message arrives in that chat, on `done`, or 90 s after its last signal.
- `chat/Conversation.tsx`: under the messages, for each active entry in the open chat, render the agent's bubble in the agent style of `docs/design/mockups/Main.dc.html`:
  - `thinking` → "<Agent> is thinking" with three animated dots (respect `prefers-reduced-motion`);
  - `tool` → "Using <tool>…";
  - `writing` → the draft text, with a blinking caret;
  - `error` → "Couldn't answer".
  Keep the view scrolled to the bottom while the draft grows. The chat list shows a small teal "typing" dot next to a chat with live agent activity.

Test (`apps/web/test/agent-activity.test.tsx`): a `writing` activity renders its draft in an agent-styled bubble, and the bubble disappears when the final message from that device is added.

### T6: End-to-end

`e2e/tests/agents.spec.ts` (extend, echo runtime): after `@Nora …`, Rareș's view shows the live bubble ("is thinking" or a growing draft) before the final message; after the final message there is no live bubble. With the stack up (`make up`, then `make dev`), `make agents-smoke` still passes. Record in the report how long the first answer takes after an add (pre-warm) and when the first draft appears.

```relay-plan
{
  "slug": "sa-realtime-agents",
  "suite": "make check",
  "setup": "pnpm install --frozen-lockfile && uv sync",
  "tasks": [
    {
      "id": "T1", "title": "Protocol for ephemeral activity", "tier": "cheap", "code": "complete", "risk": "low",
      "files": ["packages/protocol/src/index.ts", "packages/protocol/test/protocol.test.ts"],
      "deps": [],
      "behaviors": ["signal ops carry ephemeral status envelopes that never target a single device"],
      "tests": 1,
      "done": "pnpm --filter @sa/protocol typecheck && pnpm --filter @sa/protocol test"
    },
    {
      "id": "T2", "title": "Relay forwards signals without storing them", "tier": "mid", "code": "prose", "risk": "medium",
      "files": ["services/relay/src/server.ts", "services/relay/test/relay.test.ts"],
      "deps": ["T1"],
      "behaviors": ["signals reach the other active members only and are never stored",
                    "non-members cannot signal"],
      "tests": 2,
      "done": "pnpm --filter @sa/relay typecheck && pnpm --filter @sa/relay test"
    },
    {
      "id": "T3", "title": "Client engine: send and receive activity", "tier": "mid", "code": "prose", "risk": "low",
      "files": ["packages/client/src/link.ts", "packages/client/src/relay-client.ts", "packages/client/src/engine.ts",
                "packages/client/test/fake-relay.ts", "packages/client/test/engine.test.ts"],
      "deps": ["T1"],
      "behaviors": ["members exchange encrypted activity that never shows up as a message"],
      "tests": 1,
      "done": "pnpm --filter @sa/client typecheck && pnpm --filter @sa/client test"
    },
    {
      "id": "T4", "title": "Bridge: pre-warm, streaming turns, live activity", "tier": "mid", "code": "prose", "risk": "medium",
      "files": ["services/bridge/src/agents/runtime.ts", "services/bridge/src/agents/hermes.ts",
                "services/bridge/src/agents/echo.ts", "services/bridge/src/mcp/tool-log.ts",
                "services/bridge/src/agents/host.ts", "services/bridge/test/host.test.ts"],
      "deps": ["T3"],
      "behaviors": ["agents are started when added to a chat, not at the first question",
                    "a turn announces thinking, each tool call and the growing draft before the final reply"],
      "tests": 2,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge test"
    },
    {
      "id": "T5", "title": "Web: live activity bubble", "tier": "mid", "code": "prose", "risk": "low",
      "files": ["apps/web/src/state/session.ts", "apps/web/src/chat/Conversation.tsx", "apps/web/src/chat/ChatList.tsx",
                "apps/web/test/agent-activity.test.tsx"],
      "deps": ["T3"],
      "behaviors": ["everyone in the chat sees what an agent is doing and its answer forming, live"],
      "tests": 1,
      "done": "pnpm --filter @sa/web typecheck && pnpm --filter @sa/web test"
    },
    {
      "id": "T6", "title": "End-to-end", "tier": "mid", "code": "prose", "risk": "medium",
      "files": ["e2e/tests/agents.spec.ts"],
      "deps": ["T2", "T4", "T5"],
      "behaviors": ["the live bubble appears before the final answer and goes away after it"],
      "tests": 1,
      "done": "make e2e"
    }
  ]
}
```
