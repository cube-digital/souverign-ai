import { NotetakerInvite } from "@sa/protocol";
import { afterEach, expect, it } from "vitest";
import { makeLifecycle } from "../src/calls/routes.js";
import { type CallsWorld, callsWorld } from "./call-fixture.js";

let w: CallsWorld | undefined;
const savedE2ee = process.env.SA_CALL_E2EE;
afterEach(async () => {
  if (savedE2ee === undefined) delete process.env.SA_CALL_E2EE;
  else process.env.SA_CALL_E2EE = savedE2ee;
  await w?.close();
  w = undefined;
});

const noHooks = { startNotetaker: async () => {}, notetakerEnded: () => {} };

it("reconcile logs one line and leaves the rows when the call server is configured but down", async () => {
  w = await callsWorld();
  const id = await w.startCall("ana");
  for (const u of ["zed", "cy"]) {
    await w.db.query("insert into sa.call_participants (call_id, user_id) values ($1, $2)", [
      id,
      u,
    ]);
  }
  const lines: { msg: string; extra?: Record<string, unknown> }[] = [];
  const life = makeLifecycle(w.db, noHooks, (msg, extra) => {
    lines.push({ msg, ...(extra ? { extra } : {}) });
  });
  await life.reconcile();
  life.clear();
  expect(lines).toEqual([
    { msg: "call reconcile skipped", extra: { code: "livekit_unavailable", rows: 2 } },
  ]);
  const open = await w.db.query(
    "select user_id from sa.call_participants where call_id = $1 and left_at is null and user_id in ('zed', 'cy')",
    [id],
  );
  expect(open).toHaveLength(2);
});

it("a media key is 43 base64url characters, and an e2ee call refuses a notetaker without one", async () => {
  const key = "A".repeat(42) + "_";
  expect(NotetakerInvite.safeParse({ media_key: key }).success).toBe(true);
  for (const bad of ["", "AAAA", `${key}A`, `${"A".repeat(42)}=`]) {
    expect(NotetakerInvite.safeParse({ media_key: bad }).success).toBe(false);
  }

  process.env.SA_CALL_E2EE = "1";
  w = await callsWorld();
  const id = await w.startCall("ana");
  await w.api("ana", "POST", `/api/calls/${id}/token`);
  expect(await w.api("ana", "POST", `/api/calls/${id}/notetaker`, {})).toEqual({
    status: 400,
    body: { error: "media_key_required" },
  });
  expect(
    (await w.api("ana", "POST", `/api/calls/${id}/notetaker`, { media_key: "short" })).status,
  ).toBe(400);
  const nt = await w.db.query("select 1 from sa.call_notetakers where call_id = $1", [id]);
  expect(nt).toEqual([]);
});
