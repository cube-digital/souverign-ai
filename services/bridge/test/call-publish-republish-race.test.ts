import type { ServerEvent } from "@sa/protocol";
import { afterEach, expect, it } from "vitest";
import { subscribe } from "../src/approvals/events.js";
import { decide } from "../src/approvals/service.js";
import { sweep } from "../src/calls/publish.js";
import { type CallsWorld, callsWorld } from "./call-fixture.js";

let w: CallsWorld;
let unsub: () => void = () => {};
afterEach(async () => {
  unsub();
  await w.close();
});

const notes = (id: string) =>
  w.db
    .query<{ status: string; approval_id: string | null }>(
      "select status, approval_id from sa.call_notes where id = $1",
      [id],
    )
    .then((r) => r[0]);
const statusOf = (id: string) =>
  w.db
    .query<{ status: string }>("select status from sa.approvals where id = $1", [id])
    .then((r) => r[0]?.status);
const notPublishedDms = () =>
  w.posts.filter((p) => p.opts?.meta?.call_notes?.state === "not_published");

/** Runs `during` once, when the republish's new approval is announced (before it is attached). */
function onNewApproval(oldId: string, during: () => Promise<unknown>): { done: Promise<unknown> } {
  const box: { done: Promise<unknown> } = { done: Promise.resolve() };
  let fired = false;
  unsub = subscribe("ana", (e: ServerEvent) => {
    if (fired || e.type !== "approval" || e.approval.id === oldId) return;
    if (e.approval.status !== "pending") return;
    fired = true;
    box.done = during();
  });
  return box;
}

it("a sweep running while a republish requests its approval leaves the notes pending with the new approval", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  await decide(n.approvalId, "ana", { decision: "deny" });
  expect(notPublishedDms()).toHaveLength(1);

  const race = onNewApproval(n.approvalId, () => sweep(Date.now()));
  const r = await w.api("ana", "POST", `/api/calls/notes/${n.notesId}/republish`);
  await race.done;
  await sweep(Date.now());

  expect(r.status).toBe(200);
  const fresh = r.body.approval_id as string;
  expect(await notes(n.notesId)).toEqual({ status: "pending_approval", approval_id: fresh });
  expect(await statusOf(fresh)).toBe("pending");
  expect(notPublishedDms()).toHaveLength(1);
  const ok = await decide(fresh, "ana", { decision: "approve" });
  expect(ok).toMatchObject({ ok: true, approval: { status: "executed" } });
  expect(w.sent).toHaveLength(1);
});

it("notes that left pending_approval before the new approval is attached get it canceled, not stranded", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  await decide(n.approvalId, "ana", { decision: "deny" });

  let fresh = "";
  const race = onNewApproval(n.approvalId, async () => {
    const [a] = await w.db.query<{ id: string }>(
      "select id from sa.approvals where tool = 'call_notes_publish' and id <> $1",
      [n.approvalId],
    );
    fresh = a?.id ?? "";
    await w.db.query("update sa.call_notes set status = 'not_published' where id = $1", [
      n.notesId,
    ]);
  });
  const r = await w.api("ana", "POST", `/api/calls/notes/${n.notesId}/republish`);
  await race.done;

  expect(r).toEqual({ status: 409, body: { error: "not_republishable" } });
  expect(fresh).not.toBe("");
  expect(await statusOf(fresh)).toBe("canceled");
  expect(await notes(n.notesId)).toMatchObject({ status: "not_published" });
  expect(w.sent).toEqual([]);
});
