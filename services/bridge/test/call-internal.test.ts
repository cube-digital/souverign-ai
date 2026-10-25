import { afterEach, expect, it } from "vitest";
import { type CallsWorld, callsWorld, MEETING_TOKEN } from "./call-fixture.js";

let w: CallsWorld;
afterEach(async () => {
  await w.close();
});

const segs = (id: string) =>
  w.db.query<{ speaker_user_id: string }>(
    "select speaker_user_id from sa.call_segments where notetaker_id = $1",
    [id],
  );

it("a segment from an accepted, in-call speaker is stored and shown live only to people in the call; state follows a decline within one request", async () => {
  w = await callsWorld();
  // ana, bob and dan are in the call (dan declined); eve is a member who never joined
  const s = await w.scenario(["ana", "bob", "dan"]);
  const url = `/internal/calls/notetakers/${s.notetakerId}/state`;

  const state1 = await w.internal("GET", url);
  expect(state1.status).toBe(200);
  expect(state1.body.status).toBe("active");
  expect([...state1.body.consented].sort()).toEqual(["user:ana", "user:bob"]);

  const ok = await w.segment(s.notetakerId, "user:bob", "We ship on Friday", s.startedAt + 5000);
  expect(ok.status).toBe(201);
  expect((await segs(s.notetakerId)).map((r) => r.speaker_user_id)).toEqual(["bob"]);
  const live = (u: string) => w.seen(u, "call.segment");
  expect(live("ana")).toHaveLength(1);
  expect(live("bob")).toHaveLength(1);
  expect(live("ana")[0]).toMatchObject({
    type: "call.segment",
    call_id: s.callId,
    segment: { speaker_user_id: "bob", speaker_name: "Bob", t_ms: 5000, text: "We ship on Friday" },
  });
  // dan declined but is in the call, so he sees the live lines like everyone there; eve never joined
  expect(live("dan")).toHaveLength(1);
  expect(live("eve")).toHaveLength(0);
  expect(live("zed")).toHaveLength(0);

  await w.api("bob", "POST", `/api/calls/${s.callId}/consent`, { decision: "declined" });
  const state2 = await w.internal("GET", url);
  expect(state2.body.consented).toEqual(["user:ana"]);
  const after = await w.segment(s.notetakerId, "user:bob", "late words", s.startedAt + 9000);
  expect(after.status).toBe(403);
});

it("segments from a decliner, a silent person, someone who left, an agent or after the stop are refused and never stored", async () => {
  w = await callsWorld();
  const s = await w.scenario(["ana", "bob", "dan", "eve"]);
  const at = s.startedAt + 5000;

  await w.api("bob", "POST", `/api/calls/${s.callId}/leave`); // accepted, then left
  const res = await Promise.all([
    w.segment(s.notetakerId, "user:dan", "declined speaker", at),
    w.segment(s.notetakerId, "user:eve", "pending speaker", at),
    w.segment(s.notetakerId, "user:bob", "left speaker", at),
    w.segment(s.notetakerId, "agent:scribe", "agent speaker", at),
  ]);
  expect(res.map((r) => r.status)).toEqual([403, 403, 403, 403]);
  expect(res[0]?.body).toEqual({ error: "not_consented" });
  expect(await segs(s.notetakerId)).toEqual([]);

  await w.api("bob", "POST", `/api/calls/${s.callId}/token`); // bob is back and still accepted
  expect((await w.segment(s.notetakerId, "user:bob", "back again", at)).status).toBe(201);
  await w.api("eve", "POST", `/api/calls/${s.callId}/notetaker/stop`);
  const stopped = await w.segment(s.notetakerId, "user:bob", "after the stop", at + 3000);
  expect(stopped.status).toBe(409);
  expect(stopped.body).toEqual({ error: "not_active" });
  expect(await segs(s.notetakerId)).toEqual([{ speaker_user_id: "bob" }]);
});

it("internal routes refuse a wrong or missing token and any non-loopback caller", async () => {
  w = await callsWorld();
  const s = await w.scenario(["ana", "bob"]);
  const state = `/internal/calls/notetakers/${s.notetakerId}/state`;
  const seg = `/internal/calls/notetakers/${s.notetakerId}/segments`;
  const worker = `/internal/calls/notetakers/${s.notetakerId}/worker`;
  const body = {
    speaker: "user:bob",
    t0_ms: s.startedAt + 1000,
    t1_ms: s.startedAt + 2000,
    text: "hi",
  };
  const res = await Promise.all([
    w.internal("GET", state, undefined, { token: "wrong" }),
    w.internal("GET", state, undefined, { token: null }),
    w.internal("POST", seg, body, { token: "wrong" }),
    w.internal("POST", worker, { state: "joined" }, { token: null }),
    w.internal("GET", state, undefined, { remoteAddress: "10.1.2.3" }),
    w.internal("POST", seg, body, { remoteAddress: "10.1.2.3", token: MEETING_TOKEN }),
  ]);
  expect(res.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403]);
  expect(await segs(s.notetakerId)).toEqual([]);
  expect([200, 204]).toContain((await w.internal("POST", worker, { state: "joined" })).status);
});
