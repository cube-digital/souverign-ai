import type { ServerEvent } from "@sa/protocol";
import { afterEach, expect, it } from "vitest";
import { decide, gatedTool } from "../src/approvals/service.js";
import { sweep } from "../src/calls/publish.js";
import { ANCHOR, type CallsWorld, callsWorld, DM, NOTES_MD } from "./call-fixture.js";

let w: CallsWorld;
afterEach(async () => {
  await w.close();
});

const HOUR = 3_600_000;
const approve = { decision: "approve" } as const;
const EDITED = [
  "**Call notes** · Project · edited by Ana",
  "",
  "## Summary",
  "Edited summary.",
  "## Action items",
  "- [ ] Bob: call the vendor (due: Tuesday)",
].join("\n");

const approvals = () =>
  w.db.query<{
    id: string;
    status: string;
    approver_user_id: string;
    requester_user_id: string | null;
    chat_id: string;
    agent_id: string;
    result: string | null;
  }>(
    "select id, status, approver_user_id, requester_user_id, chat_id, agent_id, result from sa.approvals where tool = 'call_notes_publish' order by created_at",
  );
const notes = (id: string) =>
  w.db
    .query<{
      status: string;
      approval_id: string | null;
      approval_requested_at: Date | null;
      reminded_at: Date | null;
      published_message_id: string | null;
    }>(
      "select status, approval_id, approval_requested_at, reminded_at, published_message_id from sa.call_notes where id = $1",
      [id],
    )
    .then((r) => r[0]);
const dms = (state: string) => w.posts.filter((p) => p.opts?.meta?.call_notes?.state === state);
const types = (u: string, ...names: string[]) =>
  w.seen(u).filter((e: ServerEvent) => names.includes(e.type));

it("final notes become one 24 h approval for the inviter in her DM with Scribe, private from the chat (D-3)", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();

  const spec = gatedTool("call_notes_publish");
  expect(spec?.defaultTtlMs).toBe(24 * HOUR);
  expect(spec?.executor).toMatchObject({ editable: ["text"], alwaysAllowed: false, stamp: false });

  const rows = await approvals();
  expect(rows).toEqual([
    {
      id: n.approvalId,
      status: "pending",
      approver_user_id: "ana", // the inviter, not bob who owns the chat
      requester_user_id: "ana",
      chat_id: DM,
      agent_id: "scribe",
      result: null,
    },
  ]);
  const [ttl] = await w.db.query<{ s: string }>(
    "select extract(epoch from (expires_at - created_at)) as s from sa.approvals where id = $1",
    [n.approvalId],
  );
  expect(Number(ttl?.s)).toBeCloseTo(24 * 3600, 0);
  expect(n.args).toMatchObject({ chat_id: "c1", call_id: n.callId, notes_id: n.notesId });
  expect(String(n.args.text)).toContain(NOTES_MD);

  expect(await notes(n.notesId)).toMatchObject({
    status: "pending_approval",
    approval_id: n.approvalId,
  });
  // the owner of the chat and the other members see nothing: no card, no public stamp, no notes
  expect(types("bob", "approval", "approval_public", "call.notes")).toEqual([]);
  expect(types("dan", "approval", "approval_public", "call.notes")).toEqual([]);
  expect(types("ana", "approval")).toHaveLength(1);
  expect(w.sent).toEqual([]);
  expect(w.mem.ingested).toEqual([]);
});

it("approving with edited text posts exactly that text as Scribe in the call thread, ingests it as meeting memory and notifies every member", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();

  const r = await decide(n.approvalId, "ana", { ...approve, args: { text: EDITED } });
  expect(r).toMatchObject({ ok: true, approval: { status: "executed" } });

  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]).toMatchObject({
    agentId: "scribe",
    chatId: "c1",
    body: {
      type: "text",
      text: EDITED,
      reply_to: ANCHOR,
      meta: {
        meeting: {
          call_id: n.callId,
          action_items: [{ owner: "Bob", text: "call the vendor", due: "Tuesday" }],
        },
      },
    },
  });
  expect(w.mem.ingested).toHaveLength(1);
  expect(w.mem.ingested[0]).toMatchObject({
    namespace: "chat:c1",
    kind: "meeting",
    source: { type: "meeting", id: n.callId, title: expect.stringMatching(/^Call notes /) },
    text: EDITED,
  });
  expect(await notes(n.notesId)).toMatchObject({
    status: "published",
    published_message_id: "published-msg-1",
  });
  const ready = {
    type: "call.notes_published",
    call_id: n.callId,
    chat_id: "c1",
    message_id: "published-msg-1",
    title: expect.stringMatching(/^Project call · /),
  };
  const got = ["ana", "bob", "dan", "eve"].map((u) => types(u, "call.notes_published"));
  expect(got).toEqual([[ready], [ready], [ready], [ready]]);
  expect(
    types("cy", "call.notes_published").length + types("zed", "call.notes_published").length,
  ).toBe(0);
});

it("a decision by anyone but the inviter is refused", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();

  const byOwner = await decide(n.approvalId, "bob", approve);
  const byMember = await decide(n.approvalId, "dan", approve);
  expect(byOwner).toEqual({ ok: false, code: "not_found" });
  expect(byMember).toEqual({ ok: false, code: "not_found" });
  expect((await approvals())[0]?.status).toBe("pending");
  expect(w.sent).toEqual([]);
  expect(w.mem.ingested).toEqual([]);
});

it("denying posts and ingests nothing, marks the notes not published and sends one DM", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();

  expect(await decide(n.approvalId, "ana", { decision: "deny" })).toMatchObject({ ok: true });

  expect(w.sent).toEqual([]);
  expect(w.mem.ingested).toEqual([]);
  expect((await notes(n.notesId))?.status).toBe("not_published");
  expect(dms("not_published")).toEqual([
    {
      agentId: "scribe",
      chatId: DM,
      text: "The notes from the call in #Project were not published.",
      opts: expect.objectContaining({
        meta: expect.objectContaining({
          call_notes: { call_id: n.callId, notes_id: n.notesId, state: "not_published" },
        }),
      }),
    },
  ]);
});

it("an approval that expired is found by the sweep: same outcome, once, however often it runs", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  await w.db.query(
    "update sa.approvals set status = 'expired', decided_at = now(), expires_at = now() - interval '1 minute' where id = $1",
    [n.approvalId],
  );

  await sweep(Date.now());
  await sweep(Date.now() + 1000);

  expect((await notes(n.notesId))?.status).toBe("not_published");
  expect(dms("not_published")).toHaveLength(1);
  expect(w.sent).toEqual([]);
  expect(w.mem.ingested).toEqual([]);
});

it("the inviter gets one reminder 20 hours in, and not again after a restart", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  const now = Date.now();

  await sweep(now + 19 * HOUR);
  expect(dms("pending")).toEqual([]);

  await sweep(now + 20 * HOUR + 60_000);
  expect(dms("pending")).toHaveLength(1);
  expect(dms("pending")[0]).toMatchObject({
    agentId: "scribe",
    chatId: DM,
    text: expect.stringMatching(
      /^Your notes from the call in #Project \(.+\) are still waiting for your approval\. They expire in 4 hours\.$/,
    ),
    opts: {
      meta: { call_notes: { call_id: n.callId, notes_id: n.notesId, state: "pending" } },
    },
  });
  expect((await notes(n.notesId))?.reminded_at).not.toBeNull();

  // a fresh sweep over the same rows (restart) and a later one: still one reminder
  await sweep(now + 20 * HOUR + 120_000);
  await sweep(now + 23 * HOUR);
  expect(dms("pending")).toHaveLength(1);
});

it("only the inviter can publish again, only from not published and within 7 days; a second click is refused", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  const url = `/api/calls/notes/${n.notesId}/republish`;

  const pending = await w.api("ana", "POST", url);
  expect(pending).toEqual({ status: 409, body: { error: "not_republishable" } });

  await decide(n.approvalId, "ana", { decision: "deny" });
  const owner = await w.api("bob", "POST", url);
  expect(owner).toEqual({ status: 403, body: { error: "notes_private" } });

  await w.db.query(
    "update sa.calls set started_at = now() - interval '8 days', ended_at = now() - interval '8 days' where id = $1",
    [n.callId],
  );
  const old = await w.api("ana", "POST", url);
  expect(old).toEqual({ status: 409, body: { error: "not_republishable" } });
  await w.db.query(
    "update sa.calls set started_at = now() - interval '6 days', ended_at = null where id = $1",
    [n.callId],
  );

  const again = await w.api("ana", "POST", url);
  expect(again.status).toBe(200);
  const rows = await approvals();
  expect(rows).toHaveLength(2);
  expect(again.body).toEqual({ approval_id: rows[1]?.id });
  expect(rows[1]).toMatchObject({ status: "pending", approver_user_id: "ana", chat_id: DM });
  expect(await notes(n.notesId)).toMatchObject({
    status: "pending_approval",
    approval_id: rows[1]?.id,
    reminded_at: null,
  });

  const twice = await w.api("ana", "POST", url);
  expect(twice).toEqual({ status: 409, body: { error: "not_republishable" } });
  expect(await approvals()).toHaveLength(2);
});

it("notes are not posted when Scribe has left the chat before approval", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  await w.db.query(
    "update sa.chat_members set removed_at = now() where chat_id = 'c1' and member_id = 'scribe'",
  );

  const r = await decide(n.approvalId, "ana", approve);

  expect(r).toMatchObject({ ok: true, approval: { status: "failed" } });
  expect(w.sent).toEqual([]);
  expect(w.mem.ingested).toEqual([]);
  expect(types("bob", "call.notes_published")).toEqual([]);
  expect((await notes(n.notesId))?.status).not.toBe("published");
});

it("a failed memory ingest keeps the post", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  w.mem.ingest = async () => {
    throw new Error("memory is down");
  };

  const r = await decide(n.approvalId, "ana", approve);

  expect(r).toMatchObject({ ok: true, approval: { status: "executed" } });
  expect(w.sent).toHaveLength(1);
  expect((await approvals())[0]?.result).toContain("memory failed");
  expect((await notes(n.notesId))?.status).toBe("published");
  expect(types("bob", "call.notes_published")).toHaveLength(1);
});
