import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  MemoryClient,
  MemoryError,
  type MemoryScope,
  memory,
  setMemoryForTests,
} from "../src/memory/client.js";
import { loadScopeInput } from "../src/memory/scope-input.js";
import {
  recallScopes,
  type ScopeAgent,
  type ScopeChat,
  type ScopeInput,
} from "../src/memory/scopes.js";
import { migrate } from "../src/migrate.js";
import { FakeMemory, startFakeMemoryServer } from "./fakes/memory-fake.js";

const JOINED = 1_700_000_000_000;

const nora: ScopeAgent = { id: "nora", scope: "personal", ownerUserId: "ana", share: "always" };
const max: ScopeAgent = { id: "max", scope: "workspace", ownerUserId: null, share: "always" };

type InputOver = Partial<Omit<ScopeInput, "agent" | "chat">> & {
  agent: ScopeAgent;
  chat: Partial<ScopeChat>;
};
const input = (over: InputOver): ScopeInput => ({
  shared: [],
  noTaught: false,
  approverAvailable: true,
  ...over,
  chat: {
    id: "project",
    kind: "group",
    agentJoinedAt: JOINED,
    humans: ["ana", "bob"],
    agents: [over.agent.id],
    ...over.chat,
  },
});

const namespaces = (s: MemoryScope[]) => s.map((x) => x.namespace);
const agentScopes = (s: MemoryScope[]) => s.filter((x) => x.namespace.startsWith("agent:"));
const ownOps = { namespace: "agent:max", origin_chat_ids: ["ops"], since_ts: JOINED };

const src = (id: string, ts: number) => ({ type: "message", id, ts });

describe("recallScopes (D-9)", () => {
  it("(a) never names another agent's namespace or another chat", () => {
    const scopes = recallScopes(
      input({ agent: max, chat: { id: "project", agents: ["max", "nora"] } }),
    );
    expect(namespaces(scopes)).toEqual(["agent:max", "chat:project"]);
  });

  it("(b) the chat scope starts at the agent's joined_at, so earlier messages are not recalled", async () => {
    const scopes = recallScopes(input({ agent: max, chat: { id: "project" } }));
    expect(scopes.find((s) => s.namespace === "chat:project")?.since_ts).toBe(JOINED);
    const mem = new FakeMemory();
    const put = (id: string, ts: number) =>
      mem.ingest({
        namespace: "chat:project",
        kind: "conversation",
        source: src(id, ts),
        text: `budget ${id}`,
      });
    await put("pre-join", JOINED - 1);
    await put("at-join", JOINED);
    await put("post-join", JOINED + 5);
    const hits = await mem.recall({ scopes, query: "budget", k: 8 });
    expect(hits.map((h) => h.source.id).sort()).toEqual(["at-join", "post-join"]);
  });

  it("(c) in a shared chat own notes are limited to that chat and owner-taught", async () => {
    const scopes = recallScopes(input({ agent: max, chat: { id: "ops" } }));
    expect(scopes).toHaveLength(3);
    expect(scopes).toEqual(
      expect.arrayContaining([
        { namespace: "agent:max", origin_chat_ids: ["ops"], since_ts: JOINED },
        { namespace: "agent:max", origin_chat_ids: [null] },
        { namespace: "chat:ops", since_ts: JOINED },
      ]),
    );
    const mem = new FakeMemory();
    const put = (ns: string, origin: string | null, id: string, ts = JOINED + 1) =>
      mem.ingest({
        namespace: ns,
        kind: "knowledge",
        origin_chat_id: origin,
        source: src(id, ts),
        text: `budget ${id}`,
      });
    await put("agent:max", "ops", "learned-in-ops");
    await put("agent:max", null, "taught");
    await put("agent:max", "ops", "pre-join-note", JOINED - 1);
    await put("agent:max", null, "old-taught", JOINED - 1);
    await put("agent:max", "project", "learned-in-project");
    await put("chat:project", null, "project-message");
    await put("agent:nora", null, "nora-note");
    const hits = await mem.recall({ scopes, query: "budget", k: 8 });
    expect(hits.map((h) => h.source.id).sort()).toEqual(["learned-in-ops", "old-taught", "taught"]);
  });

  it("a personal agent's 1:1 with its owner reads all of its own space plus shared chats", () => {
    const scopes = recallScopes(
      input({
        agent: nora,
        chat: { id: "dm", kind: "dm", humans: ["ana"], agents: ["nora"] },
        shared: [{ id: "project", agentJoinedAt: JOINED + 10 }],
      }),
    );
    expect(scopes).toEqual([
      { namespace: "agent:nora", origin_chat_ids: null },
      { namespace: "chat:dm", since_ts: JOINED },
      { namespace: "chat:project", since_ts: JOINED + 10 },
    ]);
  });

  it("(d) a second agent of the same owner in a DM gets only its own space", () => {
    const second: ScopeAgent = {
      id: "nora2",
      scope: "personal",
      ownerUserId: "ana",
      share: "always",
    };
    const scopes = recallScopes(
      input({ agent: second, chat: { id: "dm2", kind: "dm", humans: ["ana"], agents: ["nora2"] } }),
    );
    expect(namespaces(scopes)).toEqual(["agent:nora2", "chat:dm2"]);
  });

  it("(f) never, ask without approver and retry exclude taught knowledge", () => {
    const base = { chat: { id: "ops" } };
    const never = recallScopes(input({ agent: { ...max, share: "never" }, ...base }));
    const askNoApprover = recallScopes(
      input({ agent: { ...max, share: "ask" }, approverAvailable: false, ...base }),
    );
    const retry = recallScopes(input({ agent: max, noTaught: true, ...base }));
    expect(agentScopes(never)).toEqual([ownOps]);
    expect(agentScopes(askNoApprover)).toEqual([ownOps]);
    expect(agentScopes(retry)).toEqual([ownOps]);
    const askWithApprover = recallScopes(input({ agent: { ...max, share: "ask" }, ...base }));
    expect(agentScopes(askWithApprover)).toHaveLength(2);
    expect(agentScopes(askWithApprover)).toEqual(
      expect.arrayContaining([ownOps, { namespace: "agent:max", origin_chat_ids: [null] }]),
    );
  });

  it("D-13: a workspace agent's DM reads only notes from the DM and chats shared with that person", () => {
    const scopes = recallScopes(
      input({
        agent: max,
        chat: { id: "dm", kind: "dm", humans: ["ana"], agents: ["max"] },
        shared: [{ id: "project", agentJoinedAt: JOINED + 10 }],
      }),
    );
    expect(scopes).toHaveLength(6);
    expect(scopes).toEqual(
      expect.arrayContaining([
        { namespace: "agent:max", origin_chat_ids: [null] },
        { namespace: "agent:max", origin_chat_ids: ["dm"], since_ts: JOINED },
        { namespace: "agent:max", origin_chat_ids: ["project"], since_ts: JOINED + 10 },
        { namespace: "chat:dm", since_ts: JOINED },
        { namespace: "chat:project", since_ts: JOINED + 10 },
      ]),
    );
  });

  it("an inactive agent gets no scopes", () => {
    expect(recallScopes(input({ agent: max, chat: { agentJoinedAt: null } }))).toEqual([]);
  });
});

describe("loadScopeInput", () => {
  it("requires both members to be active for shared chats and reports a removed agent as not joined", async () => {
    const db = await openDb("pglite://memory");
    await migrate(db);
    for (const [id, kind] of [
      ["ana", "person"],
      ["sam", "seed"],
      ["gone", "person"],
    ])
      await db.query(
        "insert into sa.users (id, display_name, pin_hash, kind) values ($1,$1,'x',$2)",
        [id, kind],
      );
    for (const a of ["nora", "other"])
      await db.query(
        "insert into sa.agents (id, owner_user_id, name, template) values ($1,'ana',$1,'general')",
        [a],
      );
    for (const [id, kind] of [
      ["dm", "dm"],
      ["both", "group"],
      ["agent-removed", "group"],
      ["human-removed", "group"],
    ])
      await db.query("insert into sa.chats (id, title, kind, created_by) values ($1,$1,$2,'ana')", [
        id,
        kind,
      ]);
    const member = (
      chat: string,
      type: string,
      id: string,
      joined: string,
      removed: string | null,
    ) =>
      db.query(
        "insert into sa.chat_members (chat_id, member_type, member_id, role, joined_at, removed_at) values ($1,$2,$3,'member',$4,$5)",
        [chat, type, id, joined, removed],
      );
    const t = "2026-01-02T00:00:00Z";
    await member("dm", "user", "ana", t, null);
    await member("dm", "agent", "nora", t, null);
    await member("dm", "agent", "other", t, "2026-01-03T00:00:00Z");
    await member("both", "user", "ana", t, null);
    await member("both", "user", "sam", t, null);
    await member("both", "user", "gone", t, "2026-01-03T00:00:00Z");
    await member("both", "agent", "nora", t, null);
    await member("agent-removed", "user", "ana", t, null);
    await member("agent-removed", "agent", "nora", t, "2026-01-03T00:00:00Z");
    await member("human-removed", "user", "ana", t, "2026-01-03T00:00:00Z");
    await member("human-removed", "agent", "nora", t, null);

    const opts = { noTaught: false, requesterUserId: null };
    const dm = await loadScopeInput(db, "nora", "dm", opts);
    expect(dm?.chat.agentJoinedAt).toBe(Date.parse(t));
    expect(dm?.chat.humans).toEqual(["ana"]);
    expect(dm?.agent).toEqual({
      id: "nora",
      scope: "personal",
      ownerUserId: "ana",
      share: "always",
    });
    expect(dm?.shared.map((s) => s.id).filter((id) => id !== "dm")).toEqual(["both"]);

    const both = await loadScopeInput(db, "nora", "both", opts);
    expect([...(both?.chat.humans ?? [])].sort()).toEqual(["ana", "sam"]);

    const removed = await loadScopeInput(db, "other", "dm", opts);
    expect(removed?.chat.agentJoinedAt).toBeNull();
    expect(await loadScopeInput(db, "missing", "dm", opts)).toBeNull();
    await db.close();
  });
});

describe("memory client", () => {
  afterEach(() => {
    setMemoryForTests(undefined);
    Reflect.deleteProperty(process.env, "MEMORY_TOKEN");
  });

  it("round-trips ingest and recall, raises MemoryError 401 on a wrong token, and is off without MEMORY_TOKEN", async () => {
    const server = await startFakeMemoryServer({ port: 18657, token: "good" });
    try {
      const client = new MemoryClient("http://127.0.0.1:18657", "good");
      const n = await client.ingest({
        namespace: "agent:nora",
        kind: "knowledge",
        origin_chat_id: null,
        source: { type: "doc", id: "contract", title: "contract.pdf", ts: 42 },
        text: "payment terms net thirty",
      });
      expect(n).toBe(1);
      const hits = await client.recall({
        scopes: [{ namespace: "agent:nora", origin_chat_ids: null }],
        query: "payment terms",
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        text: "payment terms net thirty",
        kind: "knowledge",
        origin_chat_id: null,
        score: 2,
        source: { type: "doc", id: "contract", title: "contract.pdf", ts: 42 },
      });

      const bad = new MemoryClient("http://127.0.0.1:18657", "wrong");
      const err = await bad
        .recall({ scopes: [{ namespace: "agent:nora" }], query: "payment" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MemoryError);
      expect((err as MemoryError).status).toBe(401);
    } finally {
      await server.close();
    }

    Reflect.deleteProperty(process.env, "MEMORY_TOKEN");
    setMemoryForTests(undefined);
    expect(memory()).toBeNull();
    setMemoryForTests(undefined);
    process.env.MEMORY_TOKEN = "t";
    expect(memory()).toBeInstanceOf(MemoryClient);
  });
});
