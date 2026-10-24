import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProactiveRequest } from "../src/agents/api.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { plugin } from "../src/plugins/proactive.js";
import { startAlertWatch } from "../src/proactive/alert-watch.js";
import { startRoutines } from "../src/proactive/routines.js";

// Interfaces under test besides `plugin` (routes, hooks):
//   startAlertWatch(ctx: PluginContext): Promise<{ tick(): Promise<void>; stop(): void }>
//     resolves after the alert-watch row exists and current alerts are recorded as seen;
//   startRoutines(ctx: PluginContext): { tick(now?: Date): Promise<void>; stop(): void }
//     (a Promise of it is fine; tick() is what the 60 s / 30 s timers call).
// The sim answers GET /sim/alerts?hours=1 with { hours, alerts: [{ at, severity, node, message }] }.

type Alert = { at: string; severity: string; node: string; message: string };

let db: Db;
let sim: Server;
let alerts: Alert[];
let calls: ProactiveRequest[];
let ctx: Parameters<typeof startAlertWatch>[0];
const stoppers: Array<() => void> = [];
const apps: FastifyInstance[] = [];

const MONDAY_9_05 = new Date(2026, 9, 26, 9, 5);
const diskAlert: Alert = {
  at: "2026-10-24T20:00:00Z",
  severity: "warning",
  node: "node-3",
  message: "disk usage above 80%",
};
const lagAlert: Alert = {
  at: "2026-10-24T20:30:00Z",
  severity: "critical",
  node: "db-2",
  message: "replication lag above 30 s",
};

async function sql(text: string, params?: unknown[]) {
  return db.query<Record<string, unknown>>(text, params);
}

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  for (const [id, name] of [
    ["ana", "Ana"],
    ["bob", "Bob"],
    ["carol", "Carol"],
  ] as const) {
    await sql("insert into sa.users (id, display_name, pin_hash) values ($1,$2,'x')", [id, name]);
  }
  for (const [id, name, tpl] of [
    ["ag-ops", "Ops", "ops"],
    ["ag-qa", "QA", "qa"],
    ["ag-scribe", "Scribe", "scribe"],
  ] as const) {
    await sql(
      "insert into sa.agents (id, name, template, scope, roster_id) values ($1,$2,$3,'workspace',$3)",
      [id, name, tpl],
    );
  }
  const chat = async (id: string, kind: string, seedKey: string | null, members: string[]) => {
    await sql(
      "insert into sa.chats (id, title, kind, created_by, seed_key) values ($1,$1,$2,'ana',$3)",
      [id, kind, seedKey],
    );
    for (const m of members) {
      await sql(
        "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1,$2,$3,'member')",
        [id, m.startsWith("ag-") ? "agent" : "user", m],
      );
    }
  };
  await chat("c-ops", "room", "ops", ["ana", "bob", "ag-ops"]);
  await chat("c-rel", "room", null, ["ana", "bob", "ag-qa"]);
  await chat("c-bob", "room", null, ["bob", "ag-qa"]);
  await chat("dm-ana", "dm", null, ["ana", "ag-scribe"]);
  await chat("dm-bob", "dm", null, ["bob", "ag-scribe"]);
  await chat("dm-carol", "dm", null, ["carol", "ag-scribe"]);

  alerts = [diskAlert];
  sim = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/sim/alerts?hours=1")) res.end(JSON.stringify({ hours: 1, alerts }));
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => sim.listen(0, "127.0.0.1", r));
  calls = [];
  ctx = {
    db,
    relayAdmin: { setMember: async () => {} },
    relayInternalUrl: "http://127.0.0.1:1",
    adminToken: "t",
    opsSimUrl: `http://127.0.0.1:${(sim.address() as AddressInfo).port}`,
    agentHost: {
      onAgentAdded: async () => {},
      onAgentRemoved: async () => {},
      runProactive: async (req: ProactiveRequest) => {
        calls.push(req);
        return true;
      },
    },
    log: () => {},
  };
});

afterEach(async () => {
  for (const s of stoppers.splice(0)) s();
  for (const a of apps.splice(0)) await a.close();
  sim.close();
  await db.close();
});

async function watch() {
  const w = await startAlertWatch(ctx);
  stoppers.push(() => w.stop());
  return w;
}

async function api() {
  const app = Fastify();
  apps.push(app);
  plugin.routes?.(app, {
    db,
    authenticate: async (req, reply) => {
      const u = req.headers["x-user"];
      if (typeof u === "string") return u;
      await reply.code(401).send({ error: "unauthorized" });
      return null;
    },
    agentHost: ctx.agentHost,
    opsSimUrl: ctx.opsSimUrl,
    log: () => {},
    hooks: plugin.hooks ?? {},
  });
  await app.ready();
  const as = (user: string) => ({ "x-user": user });
  return { app, as };
}

describe("alert watch", () => {
  it("posts a new alert once, again only after an hour, and not again after a restart", async () => {
    const w = await watch();
    alerts = [
      diskAlert,
      lagAlert,
      { ...lagAlert, severity: "info", node: "node-1", message: "backup done" },
    ];
    await w.tick();
    await w.tick();
    expect(calls).toEqual([
      {
        agentId: "ag-ops",
        chatId: "c-ops",
        kind: "alert",
        prompt:
          "The monitoring system raised an alert: [critical] db-2: replication lag above 30 s at 2026-10-24T20:30:00Z. Diagnose it with your tools and post one short message: what is happening, the evidence, the next action.",
      },
    ]);

    // the bridge restarts within the hour: the persisted limit still holds
    w.stop();
    const again = await watch();
    await again.tick();
    expect(calls).toHaveLength(1);

    // an hour later (the clock is the alert_posts row) the same alert may post again
    await sql(
      "update sa.alert_posts set posted_at = now() - interval '61 minutes' where alert_key like '%db-2%'",
    );
    await again.tick();
    expect(calls.map((c) => c.kind)).toEqual(["alert", "alert"]);
  });

  it("never posts alerts that exist at start, and stays silent while paused", async () => {
    const w = await watch();
    await w.tick();
    expect(calls).toEqual([]);
    expect(
      await sql(
        "select id, kind, agent_id, chat_id, prompt, paused from sa.routines where id = 'alert-watch'",
      ),
    ).toEqual([
      {
        id: "alert-watch",
        kind: "alert_watch",
        agent_id: "ag-ops",
        chat_id: "c-ops",
        prompt: "Watch alerts",
        paused: false,
      },
    ]);

    await sql("update sa.routines set paused = true where id = 'alert-watch'");
    alerts = [diskAlert, lagAlert];
    await w.tick();
    expect(calls).toEqual([]);
  });
});

describe("routines", () => {
  it("fires a due routine once per slot, skips paused, Pause all and late ones", async () => {
    await sql("insert into sa.user_prefs (user_id, pause_all) values ('bob', true)");
    const row = async (id: string, user: string, chat: string, time: string, paused = false) =>
      sql(
        `insert into sa.routines (id, kind, user_id, agent_id, chat_id, days, time_hhmm, prompt, paused)
         values ($1,'routine',$2,'ag-qa',$3,'{1,2,3,4,5}',$4,'post release status',$5)`,
        [id, user, chat, time, paused],
      );
    await row("r-due", "ana", "c-rel", "09:00");
    await row("r-paused", "ana", "c-rel", "09:00", true);
    await row("r-pause-all", "bob", "c-bob", "09:00");
    await row("r-late", "ana", "c-rel", "08:00");

    const r = await startRoutines(ctx);
    stoppers.push(() => r.stop());
    await r.tick(MONDAY_9_05);
    await r.tick(MONDAY_9_05);
    // a restart inside the same slot must not fire it again
    r.stop();
    const restarted = await startRoutines(ctx);
    stoppers.push(() => restarted.stop());
    await restarted.tick(new Date(2026, 9, 26, 9, 10));

    expect(calls).toEqual([
      {
        agentId: "ag-qa",
        chatId: "c-rel",
        prompt: "Routine set by Ana: post release status",
        kind: "routine",
        requesterUserId: "ana",
      },
    ]);
    expect(
      (await sql("select id from sa.routines where last_run_at is not null")).map((x) => x.id),
    ).toEqual(["r-due"]);
  });
});

describe("catch-up", () => {
  it("sends one catch-up on the first hello of a day, none when paused, and a welcome in a new Scribe DM", async () => {
    const { app, as } = await api();
    await sql("insert into sa.user_prefs (user_id, pause_all) values ('bob', true)");
    const hello = async (user: string) =>
      (await app.inject({ method: "POST", url: "/api/me/hello", headers: as(user) })).json();

    expect(await hello("ana")).toEqual({ catchup: true });
    expect(await hello("ana")).toEqual({ catchup: false });
    expect(await hello("bob")).toEqual({ catchup: false });
    expect(calls.map((c) => [c.agentId, c.chatId, c.kind, c.requesterUserId])).toEqual([
      ["ag-scribe", "dm-ana", "catchup", "ana"],
    ]);

    // the next local day: hello fires again
    await sql("update sa.user_prefs set last_hello_day = '2000-01-01' where user_id = 'ana'");
    expect(await hello("ana")).toEqual({ catchup: true });
    expect(calls).toHaveLength(2);

    // a new DM with Scribe gets a welcome naming the user (not for other agents or existing DMs)
    await plugin.hooks?.onAgentDm?.("carol", "ag-scribe", "dm-carol", false);
    await plugin.hooks?.onAgentDm?.("carol", "ag-qa", "dm-carol", true);
    expect(calls).toHaveLength(2);
    await plugin.hooks?.onAgentDm?.("carol", "ag-scribe", "dm-carol", true);
    expect(calls).toHaveLength(3);
    const welcome = calls[2] as ProactiveRequest;
    expect([welcome.agentId, welcome.chatId, welcome.kind, welcome.requesterUserId]).toEqual([
      "ag-scribe",
      "dm-carol",
      "welcome",
      "carol",
    ]);
    expect(welcome.prompt).toContain("Carol");
    expect(welcome.prompt).toContain("chat_digest");
    // the welcome counted as today's catch-up
    expect(await hello("carol")).toEqual({ catchup: false });
  });
});

describe("routine routes", () => {
  it("validates chat membership and lets users manage only their own routines; anyone pauses the alert watch", async () => {
    const { app, as } = await api();
    await sql(
      "insert into sa.routines (id, kind, agent_id, chat_id, prompt) values ('alert-watch','alert_watch','ag-ops','c-ops','Watch alerts')",
    );
    const body = (chat: string) => ({
      agent_id: "ag-qa",
      chat_id: chat,
      days: [1, 2, 3, 4, 5],
      time: "09:00",
      prompt: "post release status",
    });
    const post = (user: string, chat: string) =>
      app.inject({ method: "POST", url: "/api/routines", headers: as(user), payload: body(chat) });

    expect((await post("ana", "c-bob")).statusCode).toBe(403); // Ana is not in Bob's room
    const created = await post("ana", "c-rel");
    expect(created.statusCode).toBe(201);
    const routine = created.json();
    expect(routine).toEqual({
      id: routine.id,
      kind: "routine",
      user_id: "ana",
      agent_id: "ag-qa",
      chat_id: "c-rel",
      days: [1, 2, 3, 4, 5],
      time: "09:00",
      prompt: "post release status",
      paused: false,
      last_run_at: null,
    });
    expect(await sql("select id from sa.routines where kind = 'routine'")).toEqual([
      { id: routine.id },
    ]);

    // Bob can neither pause nor delete Ana's routine
    await app.inject({
      method: "PATCH",
      url: `/api/routines/${routine.id}`,
      headers: as("bob"),
      payload: { paused: true },
    });
    await app.inject({ method: "DELETE", url: `/api/routines/${routine.id}`, headers: as("bob") });
    expect(await sql("select paused from sa.routines where id = $1", [routine.id])).toEqual([
      { paused: false },
    ]);

    // anyone may pause the alert watch, nobody may delete it
    const paused = await app.inject({
      method: "PATCH",
      url: "/api/routines/alert-watch",
      headers: as("bob"),
      payload: { paused: true },
    });
    expect(paused.statusCode).toBe(200);
    expect(await sql("select paused from sa.routines where id = 'alert-watch'")).toEqual([
      { paused: true },
    ]);
    const del = await app.inject({
      method: "DELETE",
      url: "/api/routines/alert-watch",
      headers: as("ana"),
    });
    expect(del.statusCode).toBe(403);
    expect(await sql("select id from sa.routines where id = 'alert-watch'")).toEqual([
      { id: "alert-watch" },
    ]);

    // the owner can delete their own
    await app.inject({ method: "DELETE", url: `/api/routines/${routine.id}`, headers: as("ana") });
    expect(await sql("select id from sa.routines where kind = 'routine'")).toEqual([]);
  });
});
