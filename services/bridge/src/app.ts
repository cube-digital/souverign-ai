import { randomBytes } from "node:crypto";
import {
  AddMemberRequest,
  type Chat,
  CreateChatRequest,
  type DevicePublic,
  DeviceRegistration,
  type DirectoryEntry,
  EpochClaimRequest,
  LoginRequest,
  type LoginResponse,
  RelayTicketRequest,
  TICKET_TTL_MS,
  type UserSummary,
} from "@sa/protocol";
import { signTicket } from "@sa/protocol/ticket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { AgentHostApi, BridgeHooks } from "./agents/api.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { hashToken, newToken, SESSION_HOURS, verifyPin } from "./auth.js";
import type { Db } from "./db.js";
import { registerLlmProxy } from "./llm-proxy.js";
import { registerMcp } from "./mcp/server.js";
import type { ToolLog } from "./mcp/tool-log.js";
import type { BridgePlugin } from "./plugin-api.js";
import type { RelayAdmin } from "./relay-admin.js";

type DeviceRow = { id: string; owner_id: string; public_key: string };

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 5;

export function buildApp({
  db,
  relayAdmin,
  agentHost,
  toolLog,
  opsSimUrl,
  plugins,
  hooks,
}: {
  db: Db;
  relayAdmin: RelayAdmin;
  agentHost?: AgentHostApi;
  toolLog?: ToolLog;
  opsSimUrl?: string;
  plugins?: BridgePlugin[];
  hooks?: BridgeHooks;
}): FastifyInstance {
  const failedLogins = new Map<string, number[]>();
  const recentFailures = (user: string): number[] => {
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    const live = (failedLogins.get(user) ?? []).filter((t) => t > cutoff);
    if (live.length > 0) failedLogins.set(user, live);
    else failedLogins.delete(user);
    return live;
  };
  const app = Fastify({ logger: false });
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ level: "info", msg, ...extra }));

  const devicesOf = async (userIds: string[]): Promise<Map<string, DevicePublic[]>> => {
    const map = new Map<string, DevicePublic[]>(userIds.map((u) => [u, []]));
    if (userIds.length === 0) return map;
    const rows = await db.query<DeviceRow>(
      "select id, owner_id, public_key from sa.devices where owner_type = 'user' and owner_id = any($1) order by created_at, id",
      [userIds],
    );
    for (const r of rows) map.get(r.owner_id)?.push({ device_id: r.id, public_key: r.public_key });
    return map;
  };

  const loadChat = async (chatId: string): Promise<Chat | null> => {
    const [chat] = await db.query<{
      id: string;
      title: string;
      kind: Chat["kind"];
      created_by: string;
      topic: string | null;
      seed_key: string | null;
    }>("select id, title, kind, created_by, topic, seed_key from sa.chats where id = $1", [chatId]);
    if (!chat) return null;
    const members = await db.query<{
      member_type: "user" | "agent";
      member_id: string;
      role: "owner" | "member";
      display_name: string | null;
      owner_display_name: string | null;
      agent_device_id: string | null;
      agent_public_key: string | null;
      agent_scope: "personal" | "workspace" | null;
      is_seed: boolean | null;
      agent_status: "stopped" | "starting" | "running" | "error" | null;
      joined_ms: number;
    }>(
      `select m.member_type, m.member_id, m.role,
         coalesce(u.display_name, a.name) as display_name,
         ou.display_name as owner_display_name,
         ad.device_id as agent_device_id, dv.public_key as agent_public_key,
         a.scope as agent_scope, (u.kind = 'seed') as is_seed, a.status as agent_status,
         (extract(epoch from m.joined_at) * 1000)::float8 as joined_ms
       from sa.chat_members m
       left join sa.users u on m.member_type = 'user' and u.id = m.member_id
       left join sa.agents a on m.member_type = 'agent' and a.id = m.member_id
       left join sa.users ou on ou.id = a.owner_user_id
       left join sa.agent_devices ad on ad.agent_id = a.id
       left join sa.devices dv on dv.id = ad.device_id
       where m.chat_id = $1 and m.removed_at is null order by m.joined_at, m.member_id`,
      [chatId],
    );
    const devices = await devicesOf(
      members.filter((m) => m.member_type === "user").map((m) => m.member_id),
    );
    const { topic, seed_key, ...base } = chat;
    return {
      ...base,
      ...(topic ? { topic } : {}),
      ...(seed_key ? { seed_key } : {}),
      members: members.map((m) => ({
        member_type: m.member_type,
        member_id: m.member_id,
        display_name: m.display_name ?? m.member_id,
        ...(m.member_type === "agent" && m.owner_display_name
          ? { owner_display_name: m.owner_display_name }
          : {}),
        role: m.role,
        ...(m.agent_scope ? { agent_scope: m.agent_scope } : {}),
        ...(m.is_seed ? { seed: true } : {}),
        ...(m.agent_status ? { status: m.agent_status } : {}),
        joined_at: Math.round(Number(m.joined_ms)),
        devices:
          m.member_type === "user"
            ? (devices.get(m.member_id) ?? [])
            : m.agent_device_id && m.agent_public_key
              ? [{ device_id: m.agent_device_id, public_key: m.agent_public_key }]
              : [],
      })),
    };
  };

  const relayFor = async (chatId: string, userId: string, op: "add" | "remove") => {
    for (const d of (await devicesOf([userId])).get(userId) ?? []) {
      await relayAdmin.setMember({ chat_id: chatId, device_id: d.device_id, op });
    }
  };

  const authenticate = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (m?.[1]) {
      const [s] = await db.query<{ user_id: string }>(
        "select user_id from sa.sessions where token_hash = $1 and expires_at > now()",
        [hashToken(m[1])],
      );
      if (s) return s.user_id;
    }
    await reply.code(401).send({ error: "unauthorized" });
    return null;
  };

  /** Resolve chat + caller role; replies 404 for non-members, 403 when owner is required. */
  const memberGuard = async (
    req: FastifyRequest,
    reply: FastifyReply,
    needOwner: boolean,
  ): Promise<{ userId: string; chatId: string; role: "owner" | "member" } | null> => {
    const userId = await authenticate(req, reply);
    if (!userId) return null;
    const chatId = (req.params as { id: string }).id;
    const [m] = await db.query<{ role: string }>(
      "select role from sa.chat_members where chat_id = $1 and member_type = 'user' and member_id = $2 and removed_at is null",
      [chatId, userId],
    );
    if (!m) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    if (needOwner && m.role !== "owner") {
      await reply.code(403).send({ error: "forbidden" });
      return null;
    }
    return { userId, chatId, role: m.role as "owner" | "member" };
  };

  app.get("/api/healthz", async () => ({ ok: true }));

  app.get(
    "/api/users",
    async (): Promise<UserSummary[]> =>
      db.query<UserSummary>(
        "select id, display_name from sa.users where kind = 'person' order by display_name",
      ),
  );

  app.post("/api/login", async (req, reply) => {
    const body = LoginRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [u] = await db.query<{ id: string; display_name: string; pin_hash: string }>(
      "select id, display_name, pin_hash from sa.users where id = $1",
      [body.data.user_id],
    );
    if (recentFailures(body.data.user_id).length >= LOGIN_MAX_FAILURES) {
      return reply.code(429).send({ error: "too_many_attempts" });
    }
    if (!u || !verifyPin(body.data.pin, u.pin_hash)) {
      failedLogins.set(body.data.user_id, [...recentFailures(body.data.user_id), Date.now()]);
      return reply.code(401).send({ error: "wrong_pin" });
    }
    failedLogins.delete(u.id);
    const token = newToken();
    await db.query(
      "insert into sa.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(hours => $3))",
      [hashToken(token), u.id, SESSION_HOURS],
    );
    log("login", { user: u.id });
    const res: LoginResponse = { token, user: { id: u.id, display_name: u.display_name } };
    return res;
  });

  app.post("/api/devices", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const body = DeviceRegistration.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [existing] = await db.query<{ owner_id: string }>(
      "select owner_id from sa.devices where id = $1",
      [body.data.device_id],
    );
    if (existing) {
      if (existing.owner_id !== userId) return reply.code(409).send({ error: "device_taken" });
      return { ok: true };
    }
    // Relay first (add is idempotent): a failure leaves no device row, so the client can retry.
    const mine = await db.query<{ chat_id: string }>(
      "select chat_id from sa.chat_members where member_type = 'user' and member_id = $1",
      [userId],
    );
    for (const c of mine) {
      await relayAdmin.setMember({ chat_id: c.chat_id, device_id: body.data.device_id, op: "add" });
    }
    // Concurrent registrations of the same device both reach here: the loser's insert is a no-op.
    await db.query(
      `insert into sa.devices (id, owner_type, owner_id, public_key) values ($1, 'user', $2, $3)
       on conflict (id) do nothing`,
      [body.data.device_id, userId, body.data.public_key],
    );
    const [owner] = await db.query<{ owner_type: string; owner_id: string }>(
      "select owner_type, owner_id from sa.devices where id = $1",
      [body.data.device_id],
    );
    if (owner?.owner_type !== "user" || owner.owner_id !== userId) {
      return reply.code(409).send({ error: "device_taken" });
    }
    await hooks?.onDeviceRegistered?.(userId, body.data.device_id);
    log("device registered", { user: userId });
    return { ok: true };
  });

  app.post("/api/relay-ticket", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const body = RelayTicketRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [d] = await db.query(
      "select id from sa.devices where id = $1 and owner_type = 'user' and owner_id = $2",
      [body.data.device_id, userId],
    );
    if (!d) return reply.code(404).send({ error: "not_found" });
    const secret = process.env.RELAY_ADMIN_TOKEN;
    if (!secret) return reply.code(500).send({ error: "server_misconfigured" });
    const res = signTicket(secret, body.data.device_id, TICKET_TTL_MS);
    return res;
  });

  app.get("/api/directory", async (req, reply): Promise<DirectoryEntry[] | undefined> => {
    if (!(await authenticate(req, reply))) return;
    const users = await db.query<UserSummary>(
      "select id, display_name from sa.users where kind = 'person' order by display_name",
    );
    const devices = await devicesOf(users.map((u) => u.id));
    return users.map((u) => ({ ...u, devices: devices.get(u.id) ?? [] }));
  });

  app.get("/api/chats", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const ids = await db.query<{ chat_id: string }>(
      `select m.chat_id from sa.chat_members m join sa.chats c on c.id = m.chat_id
       where m.member_type = 'user' and m.member_id = $1 and m.removed_at is null
       order by c.created_at desc, c.id`,
      [userId],
    );
    const chats: Chat[] = [];
    for (const { chat_id } of ids) {
      const c = await loadChat(chat_id);
      if (c) chats.push(c);
    }
    return chats;
  });

  app.post("/api/chats", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const body = CreateChatRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const others = [...new Set(body.data.member_user_ids)].filter((id) => id !== userId);
    const everyone = [userId, ...others];
    const known = await db.query<{ id: string }>(
      "select id from sa.users where id = any($1) and kind = 'person'",
      [everyone],
    );
    if (known.length !== everyone.length) return reply.code(400).send({ error: "unknown_user" });
    const devices = await devicesOf(everyone);
    const missing = everyone.filter((u) => (devices.get(u) ?? []).length === 0);
    if (missing.length > 0) {
      return reply.code(409).send({ error: "missing_devices", missing_devices: missing });
    }
    const chatId = randomBytes(12).toString("base64url");
    const kind = others.length === 1 ? "dm" : "group";
    // Relay first: a relay failure leaves no chat row, so the client can simply retry.
    for (const u of everyone) await relayFor(chatId, u, "add");
    await db.query("insert into sa.chats (id, title, kind, created_by) values ($1, $2, $3, $4)", [
      chatId,
      body.data.title,
      kind,
      userId,
    ]);
    for (const u of everyone) {
      await db.query(
        "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'user', $2, $3)",
        [chatId, u, u === userId ? "owner" : "member"],
      );
    }
    log("chat created", { chat: chatId, members: everyone.length });
    return loadChat(chatId);
  });

  app.post("/api/chats/:id/members", async (req, reply) => {
    const g = await memberGuard(req, reply, false);
    if (!g) return;
    const [chat] = await db.query<{ kind: string }>("select kind from sa.chats where id = $1", [
      g.chatId,
    ]);
    if (g.role !== "owner" && chat?.kind !== "room") {
      return reply.code(403).send({ error: "forbidden" });
    }
    const body = AddMemberRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const target = body.data.user_id;
    const [u] = await db.query("select id from sa.users where id = $1 and kind = 'person'", [
      target,
    ]);
    if (!u) return reply.code(400).send({ error: "unknown_user" });
    if ((await devicesOf([target])).get(target)?.length === 0) {
      return reply.code(409).send({ error: "missing_devices", missing_devices: [target] });
    }
    // Relay first (idempotent): a failure leaves the DB untouched and a retry works.
    await relayFor(g.chatId, target, "add");
    await db.query(
      `insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'user', $2, 'member')
       on conflict (chat_id, member_type, member_id) do update set removed_at = null, joined_at = now()`,
      [g.chatId, target],
    );
    await hooks?.onMemberAdded?.(g.chatId, target);
    log("member added", { chat: g.chatId });
    return loadChat(g.chatId);
  });

  app.delete("/api/chats/:id/members/:userId", async (req, reply) => {
    const g = await memberGuard(req, reply, true);
    if (!g) return;
    const target = (req.params as { userId: string }).userId;
    const [active] = await db.query(
      "select member_id from sa.chat_members where chat_id = $1 and member_type = 'user' and member_id = $2 and removed_at is null",
      [g.chatId, target],
    );
    if (!active) return reply.code(404).send({ error: "not_found" });
    // Relay first (idempotent): if the DB update fails afterwards the member is still active
    // in the DB, so a retry re-sends the remove and completes.
    await relayFor(g.chatId, target, "remove");
    await db.query(
      `update sa.chat_members set removed_at = now()
       where chat_id = $1 and member_type = 'user' and member_id = $2 and removed_at is null`,
      [g.chatId, target],
    );
    log("member removed", { chat: g.chatId });
    return loadChat(g.chatId);
  });

  app.post("/api/chats/:id/epoch", async (req, reply) => {
    const g = await memberGuard(req, reply, false);
    if (!g) return;
    const body = EpochClaimRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [row] = await db.query<{ key_epoch: number }>(
      "update sa.chats set key_epoch = greatest(key_epoch + 1, $2) where id = $1 returning key_epoch",
      [g.chatId, body.data.min],
    );
    return { epoch: Number(row?.key_epoch) };
  });

  registerLlmProxy(app, db);
  registerAgentRoutes(app, {
    db,
    relayAdmin,
    ...(agentHost ? { agentHost } : {}),
    ...(hooks ? { hooks } : {}),
    authenticate,
    memberGuard,
    loadChat,
    log,
  });

  if (toolLog) registerMcp(app, { db, toolLog, opsSimUrl: opsSimUrl ?? "http://127.0.0.1:8649" });
  for (const p of plugins ?? []) {
    p.routes?.(app, {
      db,
      authenticate,
      agentHost,
      opsSimUrl: opsSimUrl ?? "http://127.0.0.1:8649",
      log,
      hooks: hooks ?? {},
    });
  }
  return app;
}
