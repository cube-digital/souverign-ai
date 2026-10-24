import { type RelayMemberChange, verifyTicket } from "@sa/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/auth.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";

const ADMIN_TOKEN = "test-relay-admin-token";
process.env.RELAY_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.BRIDGE_MASTER_KEY = "test-master-key";

let db: Db;
let calls: RelayMemberChange[];
let relayDelayMs = 0;
let app: ReturnType<typeof buildApp>;

const dev = (u: string) => ({ device_id: `${u}-device-1`, public_key: `${u}_pubkey` });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function login(user: string, pin = "123456"): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { user_id: user, pin },
  });
  return r.json().token;
}

async function register(user: string) {
  const t = await login(user);
  await app.inject({ method: "POST", url: "/api/devices", headers: auth(t), payload: dev(user) });
  return t;
}

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  for (const [id, name] of [
    ["ana", "Ana"],
    ["vlad", "Vlad"],
  ]) {
    await db.query("insert into sa.users (id, display_name, pin_hash) values ($1, $2, $3)", [
      id,
      name,
      hashPin("123456"),
    ]);
  }
  calls = [];
  relayDelayMs = 0;
  app = buildApp({
    db,
    relayAdmin: {
      setMember: async (c) => {
        if (relayDelayMs) await new Promise((r) => setTimeout(r, relayDelayMs));
        calls.push(c);
      },
    },
  });
});
afterEach(() => db.close());

describe("bridge agents, tickets and throttling", () => {
  it("mints a relay ticket only for the caller's own device", async () => {
    const ana = await register("ana");
    await register("vlad");
    const own = await app.inject({
      method: "POST",
      url: "/api/relay-ticket",
      headers: auth(ana),
      payload: { device_id: "ana-device-1" },
    });
    expect(own.statusCode).toBe(200);
    expect(verifyTicket(ADMIN_TOKEN, own.json().ticket, "ana-device-1")).toBe(true);
    const other = await app.inject({
      method: "POST",
      url: "/api/relay-ticket",
      headers: auth(ana),
      payload: { device_id: "vlad-device-1" },
    });
    expect(other.statusCode).toBe(404);
  });

  it("throttles the sixth failed login within a minute", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { user_id: "ana", pin: "000000" },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    const sixth = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { user_id: "ana", pin: "000000" },
    });
    expect(sixth.json()).toEqual({ error: "too_many_attempts" });
  });

  it("registering the same new device twice at once succeeds both times", async () => {
    const ana = await register("ana");
    const vlad = await login("vlad");
    await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(ana),
      payload: { title: "Plan", member_user_ids: [] },
    });
    // a slow relay widens the window between the ownership check and the insert
    relayDelayMs = 50;
    const second = { device_id: "ana-device-2", public_key: "ana_pubkey2" };
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/api/devices", headers: auth(ana), payload: second }),
      app.inject({ method: "POST", url: "/api/devices", headers: auth(ana), payload: second }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const taken = await app.inject({
      method: "POST",
      url: "/api/devices",
      headers: auth(vlad),
      payload: second,
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: "device_taken" });
  });

  it("agents are added only by owners of both chat and agent, and chats list them with owner name", async () => {
    const ana = await register("ana");
    const vlad = await register("vlad");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: auth(ana),
      payload: { name: "Ops", template: "devops", soul: "be brief" },
    });
    expect(created.statusCode).toBe(200);
    const agent = created.json();
    expect(agent).toMatchObject({
      name: "Ops",
      template: "devops",
      soul: "be brief",
      owner_user_id: "ana",
      status: "stopped",
    });
    const dup = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: auth(ana),
      payload: { name: "Ops", template: "qa" },
    });
    expect(dup.statusCode).toBe(409);

    const chat = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: auth(ana),
        payload: { title: "Plan", member_user_ids: ["vlad"] },
      })
    ).json();
    calls.length = 0;

    // vlad is a member but not the chat owner, and does not own the agent
    const denied = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/agents`,
      headers: auth(vlad),
      payload: { agent_id: agent.id },
    });
    expect(denied.statusCode).toBeGreaterThanOrEqual(400);
    expect(denied.statusCode).toBeLessThan(500);
    // ana owns the chat but vlad's chat/agent combination: ana cannot use an agent she doesn't own
    const vladAgent = (
      await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: auth(vlad),
        payload: { name: "Mine", template: "general" },
      })
    ).json();
    const notMine = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/agents`,
      headers: auth(ana),
      payload: { agent_id: vladAgent.id },
    });
    expect(notMine.statusCode).toBeGreaterThanOrEqual(400);
    expect(notMine.statusCode).toBeLessThan(500);
    expect(calls).toEqual([]);

    const ok = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/agents`,
      headers: auth(ana),
      payload: { agent_id: agent.id },
    });
    expect(ok.statusCode).toBe(200);
    expect(calls).toEqual([{ chat_id: chat.id, device_id: agent.device_id, op: "add" }]);

    const listed = (
      await app.inject({ method: "GET", url: "/api/chats", headers: auth(ana) })
    ).json();
    const member = listed[0].members.find(
      (m: { member_type: string }) => m.member_type === "agent",
    );
    expect(member).toMatchObject({
      member_id: agent.id,
      display_name: "Ops",
      owner_display_name: "Ana",
      role: "member",
    });
    expect(member.devices.map((d: { device_id: string }) => d.device_id)).toEqual([
      agent.device_id,
    ]);
  });
});
