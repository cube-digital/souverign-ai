import type { MessageBody, ServerEvent } from "@sa/protocol";
import type { AgentHostApi } from "../src/agents/api.js";
import type { ChatMessage } from "../src/agents/runtime.js";
import { buildApp } from "../src/app.js";
import { subscribe } from "../src/approvals/events.js";
import { initApprovals } from "../src/approvals/service.js";
import { hashToken } from "../src/auth.js";
import { setLivekitHealthForTests } from "../src/calls/livekit-health.js";
import { setMemoryForTests } from "../src/memory/client.js";
import { plugin } from "../src/plugins/calls.js";
import { approvalsWorld } from "./approvals-fixture.js";
import { FakeMemory } from "./fakes/memory-fake.js";

export const MEETING_TOKEN = "meeting-secret-1";
export const LK_SECRET = "lk-secret-0123456789-0123456789-abcdef";
export const ANCHOR = "anchor-msg-01";
export const DM = "dm-ana-scribe";
export const HUMANS = ["ana", "bob", "dan", "eve"] as const;

export const NOTES_MD = [
  "## Summary",
  "They agreed on the Friday plan.",
  "## Decisions",
  "- Ship on Friday (03:41).",
  "## Action items",
  "- [ ] Ana: send the draft (due: Monday)",
  "## Open questions",
  "- None recorded.",
].join("\n");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` returns a truthy value (no fixed sleeps in tests). */
export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

export type Sent = { agentId: string; chatId: string; body: MessageBody };
export type PostedAs = {
  agentId: string;
  chatId: string;
  text: string;
  opts?: { replyTo?: string | null; meta?: Record<string, any> } | undefined;
};
export type CompleteCall = { agentId: string; sessionKey: string; messages: ChatMessage[] };

/**
 * pglite world for calls: users ana (chat creator), bob (chat OWNER of c1), dan, eve (members),
 * cy and zed (not members), workspace agent Scribe (id `scribe`, roster_id `scribe`), and
 * ana's DM with Scribe (`dm-ana-scribe`). A fake agent host records every post, send and
 * completion. Nothing is spawned and no LiveKit server is needed.
 */
export async function callsBase(opts: { scribeInChat?: boolean } = {}) {
  const base = await approvalsWorld();
  const { db } = base;
  for (const [id, name] of [
    ["dan", "Dan"],
    ["eve", "Eve"],
    ["zed", "Zed"],
  ] as const) {
    await db.query("insert into sa.users (id, display_name, pin_hash) values ($1, $2, 'x')", [
      id,
      name,
    ]);
    await db.query(
      "insert into sa.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')",
      [hashToken(`tok-${id}`), id],
    );
  }
  await db.query(
    "insert into sa.agents (id, owner_user_id, name, template, scope, roster_id) values ('scribe', null, 'Scribe', 'scribe', 'workspace', 'scribe')",
  );
  await db.query(
    "update sa.chat_members set role = 'owner' where chat_id = 'c1' and member_id = 'bob'",
  );
  for (const u of ["dan", "eve"])
    await db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role) values ('c1','user',$1,'member')",
      [u],
    );
  if (opts.scribeInChat !== false) await addScribe(db);
  await db.query(
    "insert into sa.chats (id, title, kind, created_by) values ($1, 'Scribe', 'dm', 'ana')",
    [DM],
  );
  await db.query(
    "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1,'user','ana','owner'), ($1,'agent','scribe','member')",
    [DM],
  );

  const sent: Sent[] = [];
  const posts: PostedAs[] = [];
  const completes: CompleteCall[] = [];
  const state = {
    complete: async (_m: ChatMessage[]): Promise<string> => NOTES_MD,
  };
  const host: AgentHostApi = {
    onAgentAdded: () => {},
    onAgentRemoved: () => {},
    postAs: async (agentId, chatId, text, o) => {
      posts.push({ agentId, chatId, text, opts: o as PostedAs["opts"] });
      return `posted-msg-${posts.length}`;
    },
    sendAs: async (agentId, chatId, body) => {
      sent.push({ agentId, chatId, body });
      return `published-msg-${sent.length}`;
    },
    complete: async (agentId, sessionKey, messages) => {
      completes.push({ agentId, sessionKey, messages });
      return state.complete(messages);
    },
    runProactive: async () => true,
  };
  return { ...base, host, sent, posts, completes, state };
}

export function addScribe(db: Awaited<ReturnType<typeof approvalsWorld>>["db"]) {
  return db.query(
    "insert into sa.chat_members (chat_id, member_type, member_id, role) values ('c1','agent','scribe','member')",
  );
}

const ENV = {
  SA_NOTETAKER: "fake",
  MEETING_TOKEN,
  LIVEKIT_API_SECRET: LK_SECRET,
  LIVEKIT_URL: "ws://127.0.0.1:1",
  SA_CALL_GRACE_MS: "600000",
  SA_NOTES_INTERVAL_MS: "3600000",
} as const;

/** callsBase + approvals + FakeMemory + the calls plugin mounted on the real app (health = down). */
export async function callsWorld(opts: { scribeInChat?: boolean } = {}) {
  const b = await callsBase(opts);
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const mem = new FakeMemory();
  setMemoryForTests(mem);
  setLivekitHealthForTests(async () => false);
  initApprovals({ db: b.db, agentHost: b.host, opsSimUrl: "http://127.0.0.1:1", log: () => {} });
  await plugin.init?.({
    db: b.db,
    relayAdmin: { setMember: async () => {} },
    relayInternalUrl: "http://127.0.0.1:1",
    ticketFor: async () => "",
    opsSimUrl: "http://127.0.0.1:1",
    agentHost: b.host,
    log: () => {},
  });
  const app = buildApp({
    db: b.db,
    relayAdmin: { setMember: async () => {} },
    agentHost: b.host,
    plugins: [plugin],
  });
  await app.ready();

  const events = new Map<string, ServerEvent[]>();
  const unsub = ["ana", "bob", "cy", "dan", "eve", "zed"].map((u) => {
    events.set(u, []);
    return subscribe(u, (e) => events.get(u)?.push(e));
  });
  const seen = (u: string, type?: string): ServerEvent[] =>
    (events.get(u) ?? []).filter((e) => type === undefined || e.type === type);

  const api = async (user: string, method: "GET" | "POST", url: string, payload?: unknown) => {
    const r = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer tok-${user}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: r.statusCode, body: (r.body ? JSON.parse(r.body) : null) as any };
  };
  const internal = async (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    o: { token?: string | null; remoteAddress?: string } = {},
  ) => {
    const token = o.token === undefined ? MEETING_TOKEN : o.token;
    const r = await app.inject({
      method,
      url,
      headers: token === null ? {} : { "x-internal-token": token },
      ...(o.remoteAddress ? { remoteAddress: o.remoteAddress } : {}),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: r.statusCode, body: (r.body ? JSON.parse(r.body) : null) as any };
  };
  /** `GET /api/calls/:id` as a CallInfo, whether the route wraps it in `{call}` or not. */
  const getCall = async (user: string, callId: string) => {
    const r = await api(user, "GET", `/api/calls/${callId}`);
    return (r.body?.call ?? r.body) as any;
  };
  const startCall = async (user = "ana") => {
    const r = await api(user, "POST", "/api/chats/c1/calls");
    return r.body.call.id as string;
  };

  /**
   * ana starts the call (anchor set) and everyone in `joiners` joins. ana invites Scribe.
   * bob accepts and dan declines; eve stays silent.
   */
  const scenario = async (joiners: string[] = ["ana", "bob", "dan", "eve"]) => {
    const callId = await startCall("ana");
    await api("ana", "POST", `/api/calls/${callId}/anchor`, { message_id: ANCHOR });
    for (const u of joiners) await api(u, "POST", `/api/calls/${callId}/token`);
    await api("ana", "POST", `/api/calls/${callId}/notetaker`, {});
    const call = await getCall("ana", callId);
    const notetakerId = call.notetaker.id as string;
    if (joiners.includes("bob"))
      await api("bob", "POST", `/api/calls/${callId}/consent`, { decision: "accepted" });
    if (joiners.includes("dan"))
      await api("dan", "POST", `/api/calls/${callId}/consent`, { decision: "declined" });
    return { callId, notetakerId, startedAt: call.started_at as number };
  };
  const segment = (notetakerId: string, speaker: string, text: string, at: number) =>
    internal("POST", `/internal/calls/notetakers/${notetakerId}/segments`, {
      speaker,
      t0_ms: at,
      t1_ms: at + 2000,
      text,
    });

  /** Runs the scenario to a final draft: two accepted speakers, ana stops, the approval exists. */
  const finalNotes = async () => {
    const s = await scenario();
    await segment(s.notetakerId, "user:ana", "I will send the draft on Monday", s.startedAt + 5000);
    await segment(s.notetakerId, "user:bob", "Then we ship on Friday", s.startedAt + 9000);
    await api("ana", "POST", `/api/calls/${s.callId}/notetaker/stop`);
    const approval = await waitFor(async () => {
      const [a] = await b.db.query<{ id: string; args: Record<string, any> }>(
        "select id, args from sa.approvals where tool = 'call_notes_publish'",
      );
      return a;
    });
    const [notes] = await b.db.query<{ id: string }>(
      "select n.id from sa.call_notes n where n.notetaker_id = $1 and n.final",
      [s.notetakerId],
    );
    return { ...s, approvalId: approval.id, args: approval.args, notesId: notes?.id as string };
  };

  const close = async () => {
    await plugin.stop?.();
    for (const u of unsub) u();
    await app.close();
    setLivekitHealthForTests(undefined);
    setMemoryForTests(undefined);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await b.db.close();
  };
  return {
    ...b,
    mem,
    app,
    api,
    internal,
    getCall,
    startCall,
    scenario,
    segment,
    finalNotes,
    seen,
    close,
  };
}
export type CallsWorld = Awaited<ReturnType<typeof callsWorld>>;
