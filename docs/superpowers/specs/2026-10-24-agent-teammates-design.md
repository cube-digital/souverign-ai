# Agent teammates + UI refresh — design

Date: 2026-10-24. Status: draft for approval. Builds on
[the demo design](2026-10-24-sovereign-agents-demo-design.md) and [decisions](decisions.md); where
this document changes them it says so (D-10, D-11).

## 1. Intent

Two small teams (ours and the client's) will live in the app for a while and discover together what
on-prem agents are good for. The app should feel like a real team chat in which a ready-made crew of
agents (dev, tech, sales, QA, ops, a scribe) answers when tagged anywhere, the way people tag
`@Claude` in Slack or `@grok` under a post on X, except every model runs on the one Mac and the relay
sees only ciphertext.

Success: within five minutes of the first login a tester has tagged two agents, watched them work
visibly, got an answer grounded in real tool calls, and seen that nothing left the machine.

## 2. Goals, non-goals, anti-goals

Goals
- A predefined roster of six workspace agents, present from the first login.
- Tag-anywhere behaviour: `@Agent` in any chat or on any message, reply in a thread, follow-ups in
  that thread without re-tagging, visible progress, a Stop control, honest receipts.
- A UI rebuilt on the owner's `donna` design system (dense, monochrome chrome, brand colour only for AI
  surfaces), with threads, reactions, a mention popover, slash commands and a command palette.
- A first-run experience that teaches by doing: a seeded workspace, suggested prompts, a first DM.
- Quiet, pausable proactive behaviour (alert watch, catch-up, scheduled routines).
- Fix the six live bugs from the handoff.

Non-goals (this phase)
- Real Jira/GitLab/Confluence/CRM instances (P2 adds connectors; this phase seeds mock data).
- Voice, calls, LiveKit (P3, P4).
- Cloud models or any external AI call.

Anti-goals (a failure even if it works)
- Confident wrong answers with no trace of what the agent read (the `@grok` failure mode).
- Agents that talk unprompted so often that people mute them.
- Anything that weakens the trust model: the relay never sees keys or plaintext; agents see only chats
  they were added to, and only messages from that point on.
- The client's company or product name anywhere in the repo.

## 3. Constraints (binding)

From the architecture page and `AGENTS.md`: one Mac (M4 Max, 36 GB); every model local
(Qwen3.5 9B 4-bit on vllm-mlx, prefix cache off; EmbeddingGemma 2; whisper; Kokoro/Piper); one LLM
resident; agents are chat members with their own device keys held by the bridge; Hermes profile per
agent with built-in toolsets off and bridge MCP tools only (per-agent allowlist, ≤ 20 tools); context
= the turn plus the last 20 messages the agent may see; live activity is ephemeral; fixed ports
(agents 8701–8709). Measured: ~230 MB RSS per agent gateway; ops answers 13–50 s with 2–9 tool calls;
25.6 of 32 GiB in use, so the roster must stay small.

## 4. Decisions

### D-10 Workspace agents (amends "only chats its owner invited it to") — Claude's call, confirm

The six roster agents are **workspace agents**: owned by the workspace (a `workspace` owner row, not a
person), visible to every user, and **addable to a chat by any human member of that chat**. Adding is
the consent for that chat, exactly as an owner's invite is today; the chat key rotates as on any
membership change, and the agent reads only messages after it joined. Personal agents (created in the
UI) keep today's rule: only their owner adds them.

Why: Claude Tag and the Teams channel agent are one shared identity everyone tags; nine ports and
~230 MB per gateway rule out a roster per person.

Consequences: approvals for a workspace agent's effectful actions go to **the person who asked**
(requester-only cards, as in Claude Tag, Codex in Slack and Teams); the Stop control is requester-only;
memory for a workspace agent follows D-9 with "owner-taught" meaning taught by any user on the agent's
Knowledge tab (shown with who taught it).

### D-11 Threads and reactions in the protocol

`MessageBody` gains `reply_to` (the thread root message id) and a new encrypted `reaction` body kind
(`{target, emoji, op: add|remove}`). Both stay inside the ciphertext; the relay learns nothing new
beyond message sizes and times.

### D-12 Shared history in the demo seed rooms only (approved by the user, 2026-10-24)

The four seeded rooms (`#general`, `#ops`, `#release-7.4`, `#sales`) let a person who joins later read
their history, as in Slack or a Matrix room with shared history. Their messages are posted by demo
colleagues hosted on the Mac; one of those devices is the rooms' key custodian and seals the earlier
chat keys to a new person's device. The relay gets a per-device history window (`history_until_seq`)
and still sees only ciphertext. Joining still issues a new chat key. Every other chat keeps today's
rule (members read only from their join onwards), and **agents never get history**: they read only
from the moment they joined, in every room. The bridge can read the seed rooms, as it can read any
chat an agent is in.

## 5. The roster

Each agent: a Hermes template (`infra/hermes/templates/<id>.md`), an MCP allowlist, three example
prompts, an avatar glyph and colour. Tool data comes from the existing ops simulator, extended with
seeded mock data for this phase (P2 later swaps mocks for connectors).

| Agent | Role | Tools (MCP) | Example prompts |
|---|---|---|---|
| **Ops** | SRE on call: cluster, raft, replication, alerts, forecasts | `cluster_health`, `raft_status`, `db_sync_status`, `metric_trend`, `recent_alerts` (exist) | "Is anything about to go wrong?" · "Why is db-2 lagging?" |
| **QA** | Release quality: test runs, flaky tests, go/no-go | `test_runs`, `flaky_tests`, `release_status`, `open_tickets` (exist) | "Is 7.4 ready to ship?" · "Which tests are flaky this week?" |
| **Dev** | Engineer: merge requests, pipelines, code review of pasted diffs, errors | new `merge_requests`, `pipeline_status`, `build_log`; `open_tickets`, `release_status` | "Review this diff" · "Why did the nightly fail?" |
| **Tech** | Solution architect: architecture, runbooks, how-to, trade-offs | new `docs_search`, `doc_read` (seeded runbooks and architecture notes) | "How do we fail over node-1?" · "Explain how E2EE works here" |
| **Sales** | Account exec: account briefs, pipeline, follow-up drafts | new `crm_accounts`, `crm_deal`, `crm_activities`; drafts only | "Brief me on Northwind before the call" · "Draft a follow-up" |
| **Scribe** | Chief of staff: thread and chat summaries, catch-up, action items, standups | `chat_read` (exists), new `chat_digest` | "What did I miss?" · "Action items from this thread" |

All seeded data tells one story (the 7.4 release, node-3 disk, db-2 lag, a customer waiting on 7.4)
so agents can be asked about each other's findings in one chat.

## 6. Behaviour rules

Invocation
- `@Agent` in a message → the agent replies **in a thread under that message**. Several agents tagged
  → each replies in the same thread.
- In a thread an agent has replied in, follow-ups from the same person need no tag for 10 minutes
  (Claude Tag/Lindy style); anyone else re-tags.
- DM with an agent: every message is for it.
- Message action **"Ask an agent…"** on any message (Teams "Ask Copilot", `@grok explain this`) opens
  the thread composer with the message quoted and an agent picked.
- Slash commands: `/summarize`, `/catchup`, `/ask <agent> …`, `/standup`.
- An agent not in the chat that gets tagged → an inline prompt to the tagger: "Add Dev to this chat?
  It will see messages from now on." (D-10).
- When an agent joins, the chat shows a system line: "Dev joined · new chat key · sees messages from
  now on".
- `/access` (or "what can you access here?") → the agent lists its tools and what it can read in this
  chat. Every read tool an agent has is readable by anyone in a chat who can tag it, so allowlists
  stay role-narrow.

Visible work (converged pattern across Claude Tag, Viktor, Devin)
- Within 1 s: an 👀 reaction on the triggering message and a live status line in the thread
  ("reading 14 messages", "calling `metric_trend`") — exists, moves into the thread.
- Stop button for the requester while it works.
- Done: ✅ reaction replaces 👀; the reply streams in (exists) and ends with a **receipts footer**:
  messages read, tools called (expandable to arguments/results), model + "local" badge, duration.
- Long answers: a 2–3 line summary first, details collapsed.
- One model serves everyone: turns queue globally, human turns go before proactive ones, and a queued
  turn shows "queued, N ahead".
- 👍/👎 on every receipt; per-turn timings (no content) are logged so tester rounds can measure reply
  share, seconds to first useful answer and re-asks.
- On its first join to a chat an agent posts one short intro: its role and three example prompts as
  clickable chips. Seeded history shows as "example history", never with invented receipts.

Honesty (the `@grok` lesson)
- Templates require grounding: answer from tool results or chat content, cite them, and say "I don't
  know" or "the tools didn't return that" instead of guessing. Bug 4's fix (forced tool call on the
  first round for tool-bearing agents) enforces it mechanically.
- Every agent message carries an AI chip and the agent's name; the reasoning trace stays one click away.

Proactive (quiet by default, every routine pausable, one "Pause all" switch per user)
- **Ops alert watch:** when the simulator raises an alert, Ops posts one message in `#ops` with its
  diagnosis (rate-limited: one per alert key per hour).
- **Catch-up:** on a user's first login of the day, Scribe sends a DM with a 3-line digest of chats they
  are in (only chats Scribe is a member of).
- **Routines:** a user can schedule "every weekday 9:00, @QA post release status in #release-7.4"
  (stored per user; cron in the bridge; shown on the agent page with pause/delete).

Approvals: workspace agents in this phase only draft (Sales drafts, Dev suggests). Effectful tools and
the requester-only approval card arrive with P1 (§9).

## 7. First five minutes

1. Login → **Welcome**: "Meet your team" with the six roster cards (role, what it can see, three
   example prompts) and the trust line "Every model runs on this Mac · the relay sees ciphertext only".
2. Land in a seeded workspace: `#general`, `#ops`, `#release-7.4`, `#sales`, with a believable history
   from seeded users, each roster agent already a member where it belongs.
3. A pinned **Try this** card in `#general` with one-click prompts ("@Ops is anything about to go
   wrong?", "@QA is 7.4 ready to ship?", "@Scribe what did I miss?"). Clicking sends the message as
   the user.
4. Scribe's first DM: a short hello and a catch-up of the seeded chats.
5. The **Relay view** toggle shows the same conversation as the relay sees it.

## 8. UI/UX

Source: `donna` (MIT, the owner's project). Port patterns and code with the MIT notice; keep its
`VIBE.md` rules (13 px body, hairline borders, monochrome chrome, brand colour only for AI surfaces and
status dots, preset radii).

- **Foundation:** OKLCH tokens (light + dark), Goofy-style primitives (Button, Card, Chip, Input,
  Menu, Tabs, Toast, Toggle, Avatar, EmptyState, Icons) ported to React 19 + Tailwind 4; react-router.
- **Shell:** left sidebar (workspace, channels, DMs, an Agents section with status dots, unread
  counts), main pane, resizable right rail (thread, members, agent activity, relay view); ⌘K command
  palette; responsive down to a phone width.
- **Channel:** header (topic, members, agents), grouped messages, reactions bar, thread reply counts,
  agent messages with AI chip, status chip, tool-summary chip, receipts footer, collapsible
  reasoning, image previews, typing/working indicators.
- **Composer:** `@` mention popover (people and agents, with status), `/` command menu, attachments,
  drafts per chat, Enter/Shift+Enter.
- **Thread panel:** the root, replies, its own composer, the agent's live status.
- **Agents directory:** roster and personal agents as cards; "Add to chat"; create a personal agent.
- **Agent profile:** Overview (role, tools, example prompts, status), Activity (recent turns with
  receipts), Routines; Knowledge and Approvals tabs appear with P1.
- Keep: Login, Presenter page, Relay panel, trust strip.

## 9. Phasing

| Phase | Content | Plan |
|---|---|---|
| **T1 (this plan)** | bugs 1–6; D-10/D-11; roster + mock data + templates; threads, reactions, tag rules, receipts, Stop; proactive (alert watch, catch-up, routines); full UI refresh; seeded workspace + onboarding | `docs/relay/plans/2026-10-24-agent-teammates.md` |
| T2 | P1 memory, teaching, approvals (requester-only cards; Sales "send" and Dev "comment" become gated writes) | from `remaining-plans.md` P1 |
| T3 | P2 connectors (mock GitLab/Jira/Confluence/CRM as MCP servers, real ones by config) | P2 |
| T4 | P3 voice, P4 calls, P5 polish | P3–P5 |

## 10. The six bugs (T1)

1. Agent device relay socket stays dead after relay + bridge restart together → wait for relay
   `/healthz` before connecting, periodic socket check, resync from cursor.
2. "Create a file" hit the 180 s timeout → check Hermes `agent.log`; template says it cannot create
   files; cap tool rounds; reply with a clear limit message on timeout.
3. Large screenshots slow → downscale to ~1280 px long side before the vision call.
4. Vague questions skip tools → forced tool choice on the first round for tool-bearing agents (or
   thinking low), measured with `.handoff/bench/quant_bench.py`.
5. StrictMode double device registration → make the web registration idempotent client-side too.
6. Orphan gateways after the bridge dies (`detached: true`, SIGHUP not handled) → handle SIGHUP; pid
   files in `.run/agents/`; on start, stop a stale gateway that holds the agent's port or profile.

## 11. Left to the builder

File layout inside `apps/web`, the router's exact routes, mock data shapes, the exact wording of
templates (grounding rules above are required), animation details, the colour of each agent.
