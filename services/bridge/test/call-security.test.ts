import { afterEach, expect, it } from "vitest";
import { decide, requestApproval } from "../src/approvals/service.js";
import { setRoomAdminForTests } from "../src/calls/livekit-admin.js";
import { Notetakers } from "../src/calls/notetaker.js";
import { makeLifecycle } from "../src/calls/routes.js";
import { type CallsWorld, callsWorld, LK_SECRET, sleep, waitFor } from "./call-fixture.js";

let w: CallsWorld;
afterEach(async () => {
  setRoomAdminForTests(undefined);
  await w.close();
});

const removeFromChat = (user: string) =>
  w.db.query(
    "update sa.chat_members set removed_at = now() where chat_id = 'c1' and member_id = $1",
    [user],
  );

it("notes are not posted when the inviter left the chat, and two approvals for the same notes post once", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  await removeFromChat("ana");
  const r = await decide(n.approvalId, "ana", { decision: "approve" });
  expect(r).toMatchObject({ ok: true, approval: { status: "failed" } });
  expect(w.sent).toEqual([]);
  expect(w.mem.ingested).toEqual([]);

  await w.db.query(
    "update sa.chat_members set removed_at = null where chat_id = 'c1' and member_id = 'ana'",
  );
  const second = await requestApproval({
    agentId: "scribe",
    chatId: "dm-ana-scribe",
    replyTo: null,
    turnId: null,
    requesterUserId: "ana",
    kind: "tool",
    tool: "call_notes_publish",
    args: { chat_id: "c1", call_id: n.callId, notes_id: n.notesId, text: "second try" },
  });
  expect(second.status).toBe("pending");
  const a = await decide(n.approvalId, "ana", { decision: "approve" });
  const b =
    second.status === "pending"
      ? await decide(second.approval.id, "ana", { decision: "approve" })
      : null;
  expect(
    [a, b].filter((x) => x && "approval" in x && x.approval?.status === "executed"),
  ).toHaveLength(1);
  expect(w.sent).toHaveLength(1);
});

it("a member removed from the chat is no longer captured, hears no live lines and is removed from the room", async () => {
  w = await callsWorld();
  const s = await w.scenario(["ana", "bob", "dan"]);
  const kicked: string[] = [];
  setRoomAdminForTests({
    removeParticipant: async (_r, id) => void kicked.push(id),
    deleteRoom: async () => {},
  });
  await removeFromChat("bob");
  expect(
    (await w.segment(s.notetakerId, "user:bob", "after removal", s.startedAt + 4000)).status,
  ).toBe(403);
  const state = await w.internal("GET", `/internal/calls/notetakers/${s.notetakerId}/state`);
  expect(state.body.consented).toEqual(["user:ana"]);

  const life = makeLifecycle(
    w.db,
    { startNotetaker: async () => {}, notetakerEnded: () => {} },
    () => {},
  );
  await life.reconcile();
  life.clear();
  expect(kicked).toEqual(["user:bob"]);
});

it("declining deletes what the person said and keeps it out of the notes; names of the uncaptured are scrubbed", async () => {
  w = await callsWorld();
  const s = await w.scenario();
  await w.segment(s.notetakerId, "user:bob", "Bob secret remark", s.startedAt + 3000);
  await w.segment(s.notetakerId, "user:ana", "I will ask Dan about it", s.startedAt + 6000);
  await w.api("bob", "POST", `/api/calls/${s.callId}/consent`, { decision: "declined" });
  expect(await w.db.query("select 1 from sa.call_segments where speaker_user_id = 'bob'")).toEqual(
    [],
  );

  w.state.complete = async () =>
    "## Summary\nDan will review it, says Bob.\n## Action items\n- [ ] Dan: review the plan\n- [ ] Ana: send notes";
  await w.api("ana", "POST", `/api/calls/${s.callId}/notetaker/stop`);
  const notes = await waitFor(async () => {
    const [r] = await w.db.query<{ body_md: string; action_items: Array<{ owner: string }> }>(
      "select body_md, action_items from sa.call_notes where final",
    );
    return r;
  });
  expect(notes.body_md).not.toMatch(/\bdan\b|\bbob\b/i);
  expect(notes.body_md).toContain("a participant who was not captured");
  expect(w.completes[0]?.messages[1]?.content).not.toContain("Bob secret remark");
  expect(notes.action_items.map((i) => i.owner)).toEqual(["Unassigned", "Ana"]);
});

it("the live transcript is read only while in the call and only from the caller's join time; later only the inviter reads it", async () => {
  w = await callsWorld();
  const s = await w.scenario(["ana", "bob"]);
  await w.segment(s.notetakerId, "user:ana", "early line", Date.now() - 1000);
  await sleep(20);
  await w.api("eve", "POST", `/api/calls/${s.callId}/token`);
  await w.segment(s.notetakerId, "user:ana", "late line", Date.now() + 1000);
  const eve = await w.api("eve", "GET", `/api/calls/${s.callId}/segments`);
  expect(eve.body.segments.map((x: { text: string }) => x.text)).toEqual(["late line"]);

  await w.api("ana", "POST", `/api/calls/${s.callId}/notetaker/stop`);
  expect((await w.api("eve", "GET", `/api/calls/${s.callId}/segments`)).status).toBe(403);
  const own = await w.api("ana", "GET", `/api/calls/${s.callId}/segments`);
  expect(own.body.segments).toHaveLength(2);
});

it("start and invite are rate limited, someone who left cannot invite, and odd ids give 404 not 500", async () => {
  w = await callsWorld();
  const id = await w.startCall("ana");
  await w.api("ana", "POST", `/api/calls/${id}/token`);
  await w.api("eve", "POST", `/api/calls/${id}/token`);
  await w.api("eve", "POST", `/api/calls/${id}/leave`);
  expect((await w.api("eve", "POST", `/api/calls/${id}/notetaker`, {})).status).toBe(403);

  expect((await w.api("ana", "GET", "/api/calls/abc%00def")).status).toBe(404);
  const codes: number[] = [];
  for (let i = 0; i < 6; i++)
    codes.push((await w.api("dan", "POST", "/api/chats/c1/calls")).status);
  expect(codes.at(-1)).toBe(429);
});

it("shutting the bridge down kills the worker without marking the notetaker failed or running the final summary", async () => {
  w = await callsWorld();
  const s = await w.scenario(["ana", "bob"]);
  const exits: Array<(c: number | null) => void> = [];
  const killed: string[] = [];
  let finals = 0;
  const nts = new Notetakers({
    db: w.db,
    spawner: {
      spawn: () => ({
        pid: 1,
        onExit: (cb) => void exits.push(cb),
        kill: (sig) => void killed.push(sig ?? "SIGTERM"),
      }),
    },
    livekitAvailable: async () => true,
    log: () => {},
    onFinal: () => void finals++,
    pidDir: `${process.env.TMPDIR ?? "/tmp"}/sa-sec-pids`,
    env: { SA_NOTETAKER: "worker", LIVEKIT_API_SECRET: LK_SECRET, MEETING_TOKEN: "x" },
  });
  await nts.start(s.callId, s.notetakerId);
  nts.killAll();
  exits[0]?.(143);
  await sleep(50);
  const [row] = await w.db.query<{ status: string }>(
    "select status from sa.call_notetakers where id = $1",
    [s.notetakerId],
  );
  expect(killed).toEqual(["SIGTERM"]);
  expect(row?.status).toBe("active");
  expect(finals).toBe(0);
});
