// Acceptance tests for T8 (meeting_transcript). Assumed public surface:
//   import { plugin } from "../src/plugins/meeting-tools.js"  // plugin.init(ctx) registers the tool for "scribe"
//   the tool is called through invokeTool(agentId, "meeting_transcript", args) and returns JSON text.
// Chat and requester come only from the turn-scoped ToolLog (toolLog.begin), never from args.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  clearRegisteredTools,
  invokeTool,
  registeredTools,
  setToolDeps,
} from "../src/mcp/registry.js";
import { ToolLog } from "../src/mcp/tool-log.js";
import { migrate } from "../src/migrate.js";
import { plugin } from "../src/plugins/meeting-tools.js";

const SCRIBE = "agent-scribe-000005";
const OTHER_AGENT = "agent-ops-000001";
const VERBATIM = "verbatim-secret-words";

let db: Db;
let toolLog: ToolLog;

async function seedCall(o: {
  id: string;
  chat: string;
  notes: string;
  status: "draft" | "published";
  actions: unknown[];
  day: string;
  lines: [string, string][];
  decliner?: string;
}) {
  const start = `2026-10-${o.day}T10:00:00Z`;
  await db.query(
    "insert into sa.calls (id, chat_id, room, started_by, started_at, ended_at) values ($1,$2,$3,'ana',$4,$5)",
    [o.id, o.chat, `call-${o.id}`, start, `2026-10-${o.day}T11:00:00Z`],
  );
  await db.query(
    "insert into sa.call_notetakers (id, call_id, agent_id, invited_by, status, started_at) values ($1,$1,$2,'ana','finished',$3)",
    [o.id, SCRIBE, start],
  );
  for (const u of ["ana", "cy", "dee"]) {
    await db.query("insert into sa.call_participants (call_id, user_id) values ($1,$2)", [o.id, u]);
  }
  await db.query(
    "insert into sa.call_consents (notetaker_id, user_id, decision) values ($1,'ana','accepted'), ($1,'cy','accepted'), ($1,'dee','declined')",
    [o.id],
  );
  await db.query(
    "insert into sa.call_notes (id, notetaker_id, version, final, body_md, action_items, status) values ($1,$2,1,true,$3,$4::jsonb,$5)",
    [`n-${o.id}`, o.id, o.notes, JSON.stringify(o.actions), o.status],
  );
  for (const [i, [speaker, text]] of o.lines.entries()) {
    const t0 = new Date(Date.parse(start) + i * 60_000).toISOString();
    const t1 = new Date(Date.parse(start) + i * 60_000 + 5_000).toISOString();
    await db.query(
      "insert into sa.call_segments (notetaker_id, speaker_user_id, t0, t1, text) values ($1,$2,$3,$4,$5)",
      [o.id, speaker, t0, t1, text],
    );
  }
}

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  for (const [id, name] of [
    ["ana", "Ana"],
    ["ben", "Ben"],
    ["cy", "Cy"],
    ["dee", "Dee"],
  ]) {
    await db.query("insert into sa.users (id, display_name, pin_hash) values ($1,$2,'x')", [
      id,
      name,
    ]);
  }
  await db.query(
    "insert into sa.agents (id, owner_user_id, name, template) values ($1,'ana','Scribe','scribe'), ($2,'ana','Max','ops')",
    [SCRIBE, OTHER_AGENT],
  );
  const chats: [string, string, string, string[]][] = [
    ["C", "Team", "group", ["ana", "ben", "cy", "dee"]],
    ["D", "Other team", "group", ["ana", "ben"]],
    ["dm-ana", "Ana DM", "dm", ["ana"]],
    ["dm-ben", "Ben DM", "dm", ["ben"]],
  ];
  for (const [id, title, kind, users] of chats) {
    await db.query("insert into sa.chats (id, title, kind, created_by) values ($1,$2,$3,'ana')", [
      id,
      title,
      kind,
    ]);
    for (const [type, member] of [
      ...users.map((u) => ["user", u] as const),
      ["agent", SCRIBE] as const,
      ["agent", OTHER_AGENT] as const,
    ]) {
      await db.query(
        "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1,$2,$3,'member')",
        [id, type, member],
      );
    }
  }
  // P: published call in C. Q: newer, unpublished draft in C. X: published call in D.
  await seedCall({
    id: "P",
    chat: "C",
    notes: "## Decisions\nShip on March 12",
    status: "published",
    actions: [{ task: "Send the quote", owner: "Ana" }],
    day: "19",
    lines: [
      ["ana", `${VERBATIM} one`],
      ["cy", `${VERBATIM} two`],
    ],
  });
  await seedCall({
    id: "Q",
    chat: "C",
    notes: "DRAFT-NOTES-SENTINEL",
    status: "draft",
    actions: [],
    day: "20",
    lines: Array.from({ length: 20 }, (_, i): [string, string] => [
      i % 2 === 0 ? "ana" : "cy",
      i === 10 ? "so the delivery is March 12" : `filler talk number ${i}`,
    ]),
  });
  await seedCall({
    id: "X",
    chat: "D",
    notes: "OTHER-CHAT-NOTES-SENTINEL",
    status: "published",
    actions: [],
    day: "18",
    lines: [["ana", `${VERBATIM} other chat`]],
  });
  toolLog = new ToolLog();
  setToolDeps({ db, opsSimUrl: "http://127.0.0.1:1", toolLog });
  await plugin.init?.({
    db,
    relayAdmin: { setMember: async () => {} },
    relayInternalUrl: "http://127.0.0.1:1",
    ticketFor: async () => "",
    opsSimUrl: "http://127.0.0.1:1",
    agentHost: {} as never,
    log: () => {},
  });
});
afterEach(async () => {
  clearRegisteredTools();
  await db.close();
});

/** Runs the tool as `requester` in `chat`; returns the raw text and its parsed JSON. */
async function ask(chat: string, requester: string, args: Record<string, unknown> = {}) {
  toolLog.begin(SCRIBE, chat, { requesterUserId: requester });
  const text = await invokeTool(SCRIBE, "meeting_transcript", args);
  toolLog.end(SCRIBE);
  // biome-ignore lint/suspicious/noExplicitAny: tool output is asserted field by field
  return { text, json: JSON.parse(text) as Record<string, any> };
}

describe("meeting_transcript", () => {
  it("in the call's chat returns published notes and action items, never a transcript or a draft, even for the inviter", async () => {
    for (const who of ["ben", "ana"]) {
      const r = await ask("C", who);
      expect(r.json.call_id).toBe("P");
      expect(r.json.chat_title).toBe("Team");
      expect(r.json.notes_md).toBe("## Decisions\nShip on March 12");
      expect(r.json.action_items).toEqual([{ task: "Send the quote", owner: "Ana" }]);
      expect([...r.json.speakers].sort()).toEqual(["Ana", "Cy"]);
      expect(r.json).not.toHaveProperty("transcript");
      expect(r.text).not.toContain(VERBATIM);
      expect(r.text).not.toContain("DRAFT-NOTES-SENTINEL");
      expect(r.text).not.toContain("Dee");
    }
    const asked = await ask("C", "ben", { call_id: "Q" });
    expect(asked.text).not.toContain("DRAFT-NOTES-SENTINEL");
    expect(asked.text).not.toContain("delivery");
  });

  it("never returns another chat's call, and only the scribe template has the tool", async () => {
    const r = await ask("C", "ben", { call_id: "X" });
    expect(r.text).not.toContain("OTHER-CHAT-NOTES-SENTINEL");
    expect(r.text).not.toContain(VERBATIM);
    const inDm = await ask("dm-ana", "ana", { call_id: "X" });
    expect(inDm.text).not.toContain("OTHER-CHAT-NOTES-SENTINEL");
    expect(registeredTools("ops").map((t) => t.name)).toEqual([]);
    expect(registeredTools("scribe").map((t) => t.name)).toEqual(["meeting_transcript"]);
  });

  it("in the inviter's DM with Scribe returns the draft with published:false and the verbatim transcript", async () => {
    const r = await ask("dm-ana", "ana", { call_id: "Q" });
    expect(r.json.call_id).toBe("Q");
    expect(r.json.published).toBe(false);
    expect(r.json.notes_md).toBe("DRAFT-NOTES-SENTINEL");
    expect(r.json.truncated).toBe(false);
    expect(r.json.transcript).toHaveLength(20);
    expect(r.json.transcript[0]).toEqual({
      t: "00:00",
      speaker: "Ana",
      text: "filler talk number 0",
    });
    expect(r.json.transcript[10]).toEqual({
      t: "10:00",
      speaker: "Ana",
      text: "so the delivery is March 12",
    });
  });

  it("refuses everyone else, in their own DM or with chat and requester smuggled in the args", async () => {
    const own = await ask("dm-ben", "ben", { call_id: "Q" });
    expect(own.json).toEqual({ error: "no_call_notes_here" });
    expect(own.text).not.toContain("delivery");
    const smuggled = await ask("dm-ben", "ben", {
      call_id: "P",
      chat_id: "dm-ana",
      chatId: "dm-ana",
      requester: "ana",
      requesterUserId: "ana",
      user_id: "ana",
    });
    expect(smuggled.json).toEqual({ error: "no_call_notes_here" });
    expect(smuggled.text).not.toContain(VERBATIM);
    const inGroup = await ask("C", "ben", { call_id: "P", chat_id: "dm-ana", requester: "ana" });
    expect(inGroup.json).not.toHaveProperty("transcript");
    expect(inGroup.text).not.toContain(VERBATIM);
  });

  it("with a query returns the matching line plus one line of context each side", async () => {
    const r = await ask("dm-ana", "ana", { call_id: "Q", query: "delivery" });
    expect(r.json.transcript).toEqual([
      { t: "09:00", speaker: "Cy", text: "filler talk number 9" },
      { t: "10:00", speaker: "Ana", text: "so the delivery is March 12" },
      { t: "11:00", speaker: "Cy", text: "filler talk number 11" },
    ]);
  });
});
