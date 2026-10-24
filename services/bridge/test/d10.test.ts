import { randomBytes } from "node:crypto";
import type { RelayMemberChange } from "@sa/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt } from "../src/agents/secrets.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/auth.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";

process.env.RELAY_ADMIN_TOKEN = "test-relay-admin-token";
process.env.BRIDGE_MASTER_KEY = "test-master-key";

let db: Db;
let app: ReturnType<typeof buildApp>;
let relayCalls: RelayMemberChange[];
let added: string[];
let dmHooks: { userId: string; agentId: string; chatId: string; created: boolean }[];

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function register(user: string): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { user_id: user, pin: "123456" },
  });
  const token = login.json().token as string;
  await app.inject({
    method: "POST",
    url: "/api/devices",
    headers: auth(token),
    payload: { device_id: `${user}-device-1`, public_key: `${user}_pubkey` },
  });
  return token;
}

async function workspaceAgent(id: string, name: string, rosterId: string) {
  await db.query(
    "insert into sa.agents (id, owner_user_id, name, template, scope, roster_id) values ($1, null, $2, 'ops', 'workspace', $3)",
    [id, name, rosterId],
  );
  await db.query(
    "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1, 'agent', $2, $3)",
    [`dev-${id}`, id, `pk-${id}`],
  );
  await db.query(
    "insert into sa.agent_devices (device_id, agent_id, enc_secret_key) values ($1, $2, $3)",
    [`dev-${id}`, id, encrypt("secret")],
  );
}

async function makeChat(owner: string, members: string[], kind: "group" | "room") {
  const id = randomBytes(6).toString("hex");
  await db.query("insert into sa.chats (id, title, kind, created_by) values ($1, 'Room', $2, $3)", [
    id,
    kind,
    owner,
  ]);
  await db.query(
    "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'user', $2, 'owner')",
    [id, owner],
  );
  for (const m of members)
    await db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'user', $2, 'member')",
      [id, m],
    );
  return id;
}

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  for (const [id, name] of [
    ["ana", "Ana"],
    ["bob", "Bob"],
    ["cara", "Cara"],
  ]) {
    await db.query("insert into sa.users (id, display_name, pin_hash) values ($1, $2, $3)", [
      id,
      name,
      hashPin("123456"),
    ]);
  }
  relayCalls = [];
  added = [];
  dmHooks = [];
  app = buildApp({
    db,
    relayAdmin: {
      setMember: async (c) => {
        relayCalls.push(c);
      },
    },
    agentHost: {
      onAgentAdded: (chatId, agentId) => {
        added.push(`${chatId}:${agentId}`);
      },
      onAgentRemoved: () => {},
    },
    hooks: {
      onAgentDm: async (userId, agentId, chatId, created) => {
        dmHooks.push({ userId, agentId, chatId, created });
      },
    },
  });
});
afterEach(() => db.close());

describe("workspace agents and teammates (D-10)", () => {
  it("any member adds a workspace agent, and people are added by any member of a room but only by the owner elsewhere", async () => {
    const ana = await register("ana");
    const bob = await register("bob");
    await register("cara");
    await workspaceAgent("ag-ops", "Ops", "ops");
    const group = await makeChat("ana", ["bob"], "group");
    const room = await makeChat("ana", ["bob"], "room");

    const add = await app.inject({
      method: "POST",
      url: `/api/chats/${group}/agents`,
      headers: auth(bob),
      payload: { agent_id: "ag-ops" },
    });
    expect(add.statusCode).toBe(200);
    expect(added).toEqual([`${group}:ag-ops`]);
    expect(relayCalls).toContainEqual({ chat_id: group, device_id: "dev-ag-ops", op: "add" });

    const groupAdd = await app.inject({
      method: "POST",
      url: `/api/chats/${group}/members`,
      headers: auth(bob),
      payload: { user_id: "cara" },
    });
    const roomAdd = await app.inject({
      method: "POST",
      url: `/api/chats/${room}/members`,
      headers: auth(bob),
      payload: { user_id: "cara" },
    });
    const ownerGroupAdd = await app.inject({
      method: "POST",
      url: `/api/chats/${group}/members`,
      headers: auth(ana),
      payload: { user_id: "cara" },
    });
    expect(groupAdd.statusCode).toBe(403);
    expect(roomAdd.statusCode).toBe(200);
    expect(ownerGroupAdd.statusCode).toBe(200);
  });

  it("a personal agent is added only by its owner, who must also own the chat", async () => {
    const ana = await register("ana");
    const bob = await register("bob");
    const group = await makeChat("ana", ["bob"], "group");
    const anaAgent = (
      await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: auth(ana),
        payload: { name: "Scout", template: "general", soul: "" },
      })
    ).json();
    const bobAgent = (
      await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: auth(bob),
        payload: { name: "Rex", template: "general", soul: "" },
      })
    ).json();

    const someoneElses = await app.inject({
      method: "POST",
      url: `/api/chats/${group}/agents`,
      headers: auth(bob),
      payload: { agent_id: anaAgent.id },
    });
    const ownsAgentNotChat = await app.inject({
      method: "POST",
      url: `/api/chats/${group}/agents`,
      headers: auth(bob),
      payload: { agent_id: bobAgent.id },
    });
    const ownsBoth = await app.inject({
      method: "POST",
      url: `/api/chats/${group}/agents`,
      headers: auth(ana),
      payload: { agent_id: anaAgent.id },
    });

    expect(someoneElses.statusCode).toBe(404);
    expect(ownsAgentNotChat.statusCode).toBe(403);
    expect(ownsBoth.statusCode).toBe(200);
    expect(added).toEqual([`${group}:${anaAgent.id}`]);
  });

  it("hands out distinct chat key epochs to concurrent claims", async () => {
    const ana = await register("ana");
    const bob = await register("bob");
    const group = await makeChat("ana", ["bob"], "group");

    const claim = (token: string, min: number) =>
      app.inject({
        method: "POST",
        url: `/api/chats/${group}/epoch`,
        headers: auth(token),
        payload: { min },
      });
    const [a, b] = await Promise.all([claim(ana, 1), claim(bob, 1)]);
    const far = await claim(ana, 10);

    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().epoch, b.json().epoch].sort()).toEqual([1, 2]);
    expect(far.json()).toEqual({ epoch: 10 });
  });

  it("gives each user one DM per agent and reports it as created only once", async () => {
    const ana = await register("ana");
    const bob = await register("bob");
    await workspaceAgent("ag-ops", "Ops", "ops");
    const bobAgent = (
      await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: auth(bob),
        payload: { name: "Rex", template: "general", soul: "" },
      })
    ).json();
    const dm = () =>
      app.inject({ method: "POST", url: "/api/agents/ag-ops/dm", headers: auth(ana) });

    const first = await dm();
    const second = await dm();

    expect(first.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(first.json()).toMatchObject({ title: "Ops", kind: "dm" });
    await expect.poll(() => dmHooks.length, { timeout: 2000 }).toBe(2);
    expect(dmHooks.map((h) => h.created)).toEqual([true, false]);
    expect(dmHooks.every((h) => h.userId === "ana" && h.agentId === "ag-ops")).toBe(true);
    const chats = await db.query(
      "select id from sa.chats where created_by = 'ana' and title = 'Ops'",
    );
    expect(chats).toHaveLength(1);
    expect(added).toEqual([`${first.json().id}:ag-ops`]);
    const notMine = await app.inject({
      method: "POST",
      url: `/api/agents/${bobAgent.id}/dm`,
      headers: auth(ana),
    });
    expect(notMine.statusCode).toBe(404);
  });

  it("keeps demo colleagues out of the user list and the directory, and refuses their login", async () => {
    const ana = await register("ana");
    await db.query(
      "insert into sa.users (id, display_name, pin_hash, kind) values ('mira', 'Mira Novak', 'disabled', 'seed')",
    );

    const users = await app.inject({ method: "GET", url: "/api/users" });
    const directory = await app.inject({
      method: "GET",
      url: "/api/directory",
      headers: auth(ana),
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { user_id: "mira", pin: "123456" },
    });

    expect((users.json() as { id: string }[]).map((u) => u.id)).toEqual(["ana", "bob", "cara"]);
    expect((directory.json() as { id: string }[]).map((u) => u.id)).toEqual(["ana", "bob", "cara"]);
    expect(login.statusCode).toBe(401);
  });

  it("refuses a personal agent that takes a workspace agent's name, ignoring case, and its edit", async () => {
    const ana = await register("ana");
    await workspaceAgent("ag-ops", "Ops", "ops");

    const taken = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: auth(ana),
      payload: { name: "ops", template: "general", soul: "" },
    });
    const edit = await app.inject({
      method: "PATCH",
      url: "/api/agents/ag-ops",
      headers: auth(ana),
      payload: { soul: "hijacked" },
    });
    const list = await app.inject({ method: "GET", url: "/api/agents", headers: auth(ana) });

    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: "name_taken" });
    expect(edit.statusCode).toBe(404);
    expect((list.json() as { id: string }[]).map((a) => a.id)).toEqual(["ag-ops"]);
  });
});
