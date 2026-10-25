import { afterEach, expect, it } from "vitest";
import { ANCHOR, addScribe, type CallsWorld, callsWorld } from "./call-fixture.js";

let w: CallsWorld;
afterEach(async () => {
  await w.close();
});

it("a second start returns the same call; the token says audio is unavailable without a call server; call.updated reaches every chat member and nobody else", async () => {
  w = await callsWorld();
  const first = await w.api("ana", "POST", "/api/chats/c1/calls");
  const second = await w.api("bob", "POST", "/api/chats/c1/calls");
  expect(first.status).toBe(201);
  expect(second.status).toBe(200);
  const id = first.body.call.id as string;
  expect(second.body.call.id).toBe(id);
  expect(first.body.call.e2ee).toBe(false);

  const tok = await w.api("bob", "POST", `/api/calls/${id}/token`);
  expect(tok.status).toBe(200);
  expect(tok.body).toMatchObject({ available: false, identity: "user:bob" });

  const info = await w.getCall("ana", id);
  expect(info.participants).toContainEqual({
    user_id: "bob",
    name: "Bob",
    in_call: true,
    consent: "pending",
  });

  await w.api("bob", "POST", `/api/calls/${id}/leave`);
  const left = await w.getCall("ana", id);
  expect(left.participants).toContainEqual({
    user_id: "bob",
    name: "Bob",
    in_call: false,
    consent: "pending",
  });

  const got = ["ana", "bob", "dan", "eve"].map((u) => w.seen(u, "call.updated").length > 0);
  expect(got).toEqual([true, true, true, true]);
  expect(w.seen("cy").length + w.seen("zed").length).toBe(0);
});

it("a non-member gets 403 on every call route and no token; a member who has not joined cannot use participant routes", async () => {
  w = await callsWorld();
  const id = await w.startCall("ana");
  const routes: Array<["GET" | "POST", string, unknown?]> = [
    ["POST", "/api/chats/c1/calls"],
    ["GET", `/api/calls/${id}`],
    ["POST", `/api/calls/${id}/anchor`, { message_id: ANCHOR }],
    ["POST", `/api/calls/${id}/token`],
    ["POST", `/api/calls/${id}/leave`],
    ["POST", `/api/calls/${id}/end`],
    ["POST", `/api/calls/${id}/notetaker`, {}],
    ["POST", `/api/calls/${id}/consent`, { decision: "accepted" }],
    ["POST", `/api/calls/${id}/notetaker/stop`],
    ["GET", `/api/calls/${id}/segments`],
    ["GET", `/api/calls/${id}/notes`],
  ];
  const outsider = await Promise.all(routes.map(([m, u, b]) => w.api("zed", m, u, b)));
  expect(outsider.map((r) => r.status)).toEqual(routes.map(() => 403));
  const cyRes = await Promise.all(routes.map(([m, u, b]) => w.api("cy", m, u, b)));
  expect(cyRes.map((r) => r.status)).toEqual(routes.map(() => 403));

  // eve is a member who has not joined: not a participant, not the starter, not the owner
  const member = await Promise.all(
    [
      ["POST", `/api/calls/${id}/leave`],
      ["POST", `/api/calls/${id}/end`],
      ["POST", `/api/calls/${id}/notetaker`, {}],
      ["POST", `/api/calls/${id}/notetaker/stop`],
      ["GET", `/api/calls/${id}/segments`],
    ].map(([m, u, b]) => w.api("eve", m as "GET" | "POST", u as string, b)),
  );
  expect(member.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
  const info = await w.getCall("ana", id);
  expect(info.ended_at).toBeNull();
  expect(info.participants).not.toContainEqual(expect.objectContaining({ user_id: "eve" }));
});

it("the notetaker needs Scribe in the chat; a second invite while one is active is refused", async () => {
  w = await callsWorld({ scribeInChat: false });
  const id = await w.startCall("ana");
  await w.api("ana", "POST", `/api/calls/${id}/token`);
  await w.api("bob", "POST", `/api/calls/${id}/token`);

  const noScribe = await w.api("ana", "POST", `/api/calls/${id}/notetaker`, {});
  expect(noScribe.status).toBe(409);
  expect(noScribe.body).toEqual({ error: "notetaker_not_in_chat" });

  await addScribe(w.db);
  const ok = await w.api("ana", "POST", `/api/calls/${id}/notetaker`, {});
  expect([200, 201]).toContain(ok.status);
  const second = await w.api("bob", "POST", `/api/calls/${id}/notetaker`, {});
  expect(second.status).toBe(409);
  expect(second.body).toEqual({ error: "notetaker_active" });

  const info = await w.getCall("bob", id);
  expect(info.notetaker).toMatchObject({
    agent_id: "scribe",
    invited_by: "ana",
    invited_by_name: "Ana",
    status: "active",
  });
  const rows = await w.db.query("select 1 from sa.call_notetakers where call_id = $1", [id]);
  expect(rows).toHaveLength(1);
});

it("each person accepts or declines; silence stays pending and the inviter always stays accepted", async () => {
  w = await callsWorld();
  const { callId } = await w.scenario();

  const inviter = await w.api("ana", "POST", `/api/calls/${callId}/consent`, {
    decision: "declined",
  });
  expect(inviter.status).toBe(409);
  expect(inviter.body).toEqual({ error: "inviter_always_consents" });

  const info = await w.getCall("eve", callId);
  const byUser = Object.fromEntries(
    info.participants.map((x: { user_id: string; consent: string }) => [x.user_id, x.consent]),
  );
  expect(byUser).toEqual({ ana: "accepted", bob: "accepted", dan: "declined", eve: "pending" });

  // a change of mind is allowed and takes effect
  await w.api("dan", "POST", `/api/calls/${callId}/consent`, { decision: "accepted" });
  const again = await w.getCall("eve", callId);
  expect(again.participants).toContainEqual(
    expect.objectContaining({ user_id: "dan", consent: "accepted" }),
  );
});

it("anyone in the call can stop the notes; only the inviter can read them", async () => {
  w = await callsWorld();
  const { callId } = await w.scenario();

  const stop = await w.api("dan", "POST", `/api/calls/${callId}/notetaker/stop`);
  expect(stop.status).toBe(200);
  const info = await w.getCall("ana", callId);
  expect(info.notetaker).toMatchObject({ status: "stopped", stopped_by_name: "Dan" });

  const notes = await Promise.all(
    ["bob", "dan", "eve"].map((u) => w.api(u, "GET", `/api/calls/${callId}/notes`)),
  );
  expect(notes.map((r) => [r.status, r.body])).toEqual([
    [403, { error: "notes_private" }],
    [403, { error: "notes_private" }],
    [403, { error: "notes_private" }],
  ]);
  const own = await w.api("ana", "GET", `/api/calls/${callId}/notes`);
  expect(own.status).toBe(200);
});

it("a LiveKit webhook with a bad or missing signature is refused and changes nothing", async () => {
  w = await callsWorld();
  const id = await w.startCall("ana");
  const body = JSON.stringify({ event: "room_finished", room: { name: `call-${id}` } });
  const bad = await w.app.inject({
    method: "POST",
    url: "/internal/livekit/webhook",
    headers: { "content-type": "application/webhook+json", authorization: "not.a.token" },
    payload: body,
  });
  const none = await w.app.inject({
    method: "POST",
    url: "/internal/livekit/webhook",
    headers: { "content-type": "application/webhook+json" },
    payload: body,
  });
  expect([bad.statusCode, none.statusCode]).toEqual([401, 401]);
  expect((await w.getCall("ana", id)).ended_at).toBeNull();
});
