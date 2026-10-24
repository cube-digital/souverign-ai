import type { RelayMemberChange } from "@sa/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/auth.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";

let db: Db;
let calls: RelayMemberChange[];
let app: ReturnType<typeof buildApp>;

const dev = (u: string) => ({ device_id: `${u}-device-1`, public_key: `${u}_pubkey` });

async function login(user: string, pin = "123456"): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { user_id: user, pin },
  });
  return r.json().token;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  for (const [id, name] of [
    ["ana", "Ana"],
    ["vlad", "Vlad"],
    ["rares", "Rareș"],
  ]) {
    await db.query("insert into sa.users (id, display_name, pin_hash) values ($1, $2, $3)", [
      id,
      name,
      hashPin("123456"),
    ]);
  }
  calls = [];
  app = buildApp({ db, relayAdmin: { setMember: async (c) => void calls.push(c) } });
});
afterEach(() => db.close());

async function register(user: string) {
  const t = await login(user);
  await app.inject({ method: "POST", url: "/api/devices", headers: auth(t), payload: dev(user) });
  return t;
}

describe("bridge", () => {
  it("refuses a wrong PIN and issues a working token for the right one", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { user_id: "ana", pin: "000000" },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: "wrong_pin" });
    const token = await login("ana");
    const chats = await app.inject({ method: "GET", url: "/api/chats", headers: auth(token) });
    expect(chats.statusCode).toBe(200);
    expect(chats.json()).toEqual([]);
  });

  it("creating a chat adds every member device to the relay; missing devices give 409", async () => {
    const ana = await register("ana");
    await register("vlad");
    const res = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(ana),
      payload: { title: "Plan", member_user_ids: ["vlad"] },
    });
    expect(res.statusCode).toBe(200);
    const chat = res.json();
    expect(
      chat.members.map((m: { member_id: string; role: string }) => [m.member_id, m.role]),
    ).toEqual([
      ["ana", "owner"],
      ["vlad", "member"],
    ]);
    expect(calls.map((c) => [c.chat_id, c.device_id, c.op]).sort()).toEqual(
      [
        [chat.id, "ana-device-1", "add"],
        [chat.id, "vlad-device-1", "add"],
      ].sort(),
    );
    calls.length = 0;
    const no = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(ana),
      payload: { title: "Nope", member_user_ids: ["rares"] },
    });
    expect(no.statusCode).toBe(409);
    expect(no.json()).toEqual({ error: "missing_devices", missing_devices: ["rares"] });
    expect(calls).toEqual([]);
  });

  it("only the owner can remove a member, and removal reaches the relay", async () => {
    const ana = await register("ana");
    const vlad = await register("vlad");
    const chat = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: auth(ana),
        payload: { title: "Plan", member_user_ids: ["vlad"] },
      })
    ).json();
    calls.length = 0;
    const denied = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}/members/ana`,
      headers: auth(vlad),
    });
    expect(denied.statusCode).toBe(403);
    expect(calls).toEqual([]);
    const ok = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}/members/vlad`,
      headers: auth(ana),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().members.map((m: { member_id: string }) => m.member_id)).toEqual(["ana"]);
    expect(calls).toEqual([{ chat_id: chat.id, device_id: "vlad-device-1", op: "remove" }]);
  });
});
