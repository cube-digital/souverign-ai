import { createHash } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { afterEach, expect, it } from "vitest";
import { decide } from "../src/approvals/service.js";
import { setRoomAdminForTests } from "../src/calls/livekit-admin.js";
import { Notetakers } from "../src/calls/notetaker.js";
import { sweep } from "../src/calls/publish.js";
import { recoverAfterRestart } from "../src/calls/recovery.js";
import { makeLifecycle } from "../src/calls/routes.js";
import { NotesScheduler } from "../src/calls/scheduler.js";
import { scrubNames } from "../src/calls/summary.js";
import { type CallsWorld, callsWorld, LK_SECRET, sleep, waitFor } from "./call-fixture.js";

let w: CallsWorld;
afterEach(async () => {
  setRoomAdminForTests(undefined);
  if (w) await w.close();
  w = undefined as unknown as CallsWorld;
});

const noHooks = { startNotetaker: async () => {}, notetakerEnded: () => {} };
const removeFromChat = (user: string) =>
  w.db.query(
    "update sa.chat_members set removed_at = now() where chat_id = 'c1' and member_id = $1",
    [user],
  );

async function webhook(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const t = new AccessToken("sa-dev", LK_SECRET);
  t.sha256 = createHash("sha256").update(body).digest("base64");
  return w.app.inject({
    method: "POST",
    url: "/internal/livekit/webhook",
    headers: { "content-type": "application/webhook+json", authorization: await t.toJwt() },
    payload: body,
  });
}

it("a removed member who rejoins the room is kicked, and a failed kick is retried on the next sweep", async () => {
  w = await callsWorld();
  const id = await w.startCall("ana");
  await w.api("ana", "POST", `/api/calls/${id}/token`);
  await removeFromChat("dan");
  const kicks: string[] = [];
  const rooms: string[] = [];
  setRoomAdminForTests({
    removeParticipant: async (_r, ident) => void kicks.push(ident),
    deleteRoom: async (r) => void rooms.push(r),
  });
  const res = await webhook({
    event: "participant_joined",
    room: { name: `call-${id}` },
    participant: { identity: "user:dan" },
  });
  expect(res.statusCode).toBe(200);
  expect(kicks).toEqual(["user:dan"]);
  expect(
    (await w.getCall("ana", id)).participants.map((p: { user_id: string }) => p.user_id),
  ).toEqual(["ana"]);

  // a stranded participant: the first kick fails, the row stays, the next sweep succeeds
  await w.db.query("insert into sa.call_participants (call_id, user_id) values ($1, 'dan')", [id]);
  let calls = 0;
  setRoomAdminForTests({
    removeParticipant: async () => {
      if (++calls === 1) throw new Error("server busy");
    },
    deleteRoom: async (r) => void rooms.push(r),
  });
  const life = makeLifecycle(w.db, noHooks, () => {});
  const left = () =>
    w.db.query(
      "select 1 from sa.call_participants where call_id = $1 and user_id = 'dan' and left_at is null",
      [id],
    );
  await life.reconcile();
  expect(await left()).toHaveLength(1);
  await life.reconcile();
  expect(await left()).toHaveLength(0);
  expect(calls).toBe(2);
  life.clear();

  // ending the call closes the room
  await w.api("ana", "POST", `/api/calls/${id}/end`);
  expect(rooms).toEqual([`call-${id}`]);
});

it("after a restart a notetaker without a worker fails and is summarised, and an empty active call ends", async () => {
  w = await callsWorld();
  const s = await w.scenario(["ana", "bob"]);
  await w.segment(s.notetakerId, "user:ana", "hello there", s.startedAt + 2000);
  await w.db.query("update sa.call_notetakers set worker = 'joined' where id = $1", [
    s.notetakerId,
  ]);
  const spawner = { spawn: () => ({ pid: 1, onExit: () => {}, kill: () => {} }) };
  const notetakers = new Notetakers({
    db: w.db,
    spawner,
    log: () => {},
    onFinal: () => {},
    env: {},
  });
  const scheduler = new NotesScheduler({
    db: w.db,
    agentHost: w.host,
    intervalMs: 1e9,
    log: () => {},
  });
  const life = makeLifecycle(w.db, noHooks, () => {});
  await w.db.query("update sa.call_participants set left_at = now() where call_id = $1", [
    s.callId,
  ]);

  await recoverAfterRestart({ db: w.db, notetakers, scheduler, life, log: () => {} });
  life.clear();
  const [nt] = await w.db.query<{ status: string; worker: string }>(
    "select status, worker from sa.call_notetakers where id = $1",
    [s.notetakerId],
  );
  expect(nt).toEqual({ status: "failed", worker: "error" });
  expect(await w.db.query("select 1 from sa.call_notes where final")).toHaveLength(1);
  expect((await w.getCall("ana", s.callId)).ended_at).not.toBeNull();
});

it("scrubbing keeps ordinary words and ignores diacritics, while a full name matches in any case", () => {
  const out = scrubNames(
    "They will ship. Smith agreed; will smith too. Rares and Rareș spoke.",
    ["Will Smith", "Rareș"],
    [],
  );
  expect(out).toContain("They will ship.");
  expect(out).not.toMatch(/Smith|smith/);
  expect(out).not.toMatch(/Rare/);
  expect(scrubNames("Will joins", ["Will Smith"], [])).toContain(
    "a participant who was not captured joins",
  );
});

it("one user's start burst does not lock out another user; the notetaker cap, the cooldown and odd ids are enforced", async () => {
  w = await callsWorld();
  for (let i = 0; i < 5; i++) await w.api("dan", "POST", "/api/chats/c1/calls");
  expect((await w.api("eve", "POST", "/api/chats/c1/calls")).status).toBe(200);

  const id = await w.startCall("ana");
  await w.api("ana", "POST", `/api/calls/${id}/token`);
  process.env.SA_NOTETAKER_MAX = "0";
  expect((await w.api("ana", "POST", `/api/calls/${id}/notetaker`, {})).status).toBe(201);
  delete process.env.SA_NOTETAKER_MAX;
  await w.api("ana", "POST", `/api/calls/${id}/notetaker/stop`);

  // worker mode with no call server: the invite fails, and an immediate retry is refused
  process.env.SA_NOTETAKER = "worker";
  const first = await w.api("ana", "POST", `/api/calls/${id}/notetaker`, {});
  const again = await w.api("ana", "POST", `/api/calls/${id}/notetaker`, {});
  process.env.SA_NOTETAKER = "fake";
  expect([first.status, again.status]).toEqual([503, 429]);

  expect((await w.api("ana", "POST", "/api/calls/notes/abc%00def/republish")).status).toBe(404);
});

it("a failed post puts the notes back, and notes stuck as published without a message are released once", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  const send = w.host.sendAs;
  w.host.sendAs = async () => {
    throw new Error("relay down");
  };
  const r = await decide(n.approvalId, "ana", { decision: "approve" });
  w.host.sendAs = send;
  expect(r).toMatchObject({ ok: true, approval: { status: "failed" } });
  const status = async () =>
    (
      await w.db.query<{ status: string }>("select status from sa.call_notes where id = $1", [
        n.notesId,
      ])
    )[0]?.status;
  expect(await status()).toBe("pending_approval");

  await w.db.query("update sa.call_notes set status = 'published' where id = $1", [n.notesId]);
  await w.db.query("update sa.approvals set decided_at = now() where id = $1", [n.approvalId]);
  await sweep(Date.now());
  expect(await status()).toBe("published");
  await sweep(Date.now() + 10 * 60_000);
  await sweep(Date.now() + 11 * 60_000);
  expect(await status()).toBe("not_published");
  expect(w.posts.filter((p) => p.opts?.meta?.call_notes?.state === "not_published")).toHaveLength(
    1,
  );
  void sleep;
  void waitFor;
});
