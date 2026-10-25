import { randomBytes } from "node:crypto";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import {
  AddAgentRequest,
  type Agent,
  type Chat,
  CreateAgentRequest,
  UpdateAgentRequest,
} from "@sa/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import type { RelayAdmin } from "../relay-admin.js";
import type { AgentHostApi, BridgeHooks } from "./api.js";
import { encrypt } from "./secrets.js";

export type AgentHost = AgentHostApi;

export type AgentRoutesDeps = {
  db: Db;
  relayAdmin: RelayAdmin;
  agentHost?: AgentHost;
  hooks?: BridgeHooks;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<string | null>;
  memberGuard: (
    req: FastifyRequest,
    reply: FastifyReply,
    needOwner: boolean,
  ) => Promise<{ userId: string; chatId: string; role: "owner" | "member" } | null>;
  loadChat: (chatId: string) => Promise<Chat | null>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
};

type AgentRow = Omit<Agent, "device_id"> & { device_id: string };

const ROSTER_ORDER = "array['ops','qa','dev','tech','sales','scribe']";
const PERSONAL_TEMPLATES = ["general", "devops"];

const AGENT_SELECT = `select a.id, a.name, a.template, a.soul, a.owner_user_id, a.status, a.scope, a.roster_id, a.share_private_in_chats, d.device_id
  from sa.agents a join sa.agent_devices d on d.agent_id = a.id`;

const dmLocks = new Map<string, Promise<void>>();

/**
 * The DM of a user with an agent, created when missing (relay membership, chat row at key_epoch 1:
 * the user's first open mints the first key). One bridge process: a per-(user, agent) lock makes
 * concurrent callers share one chat.
 */
export async function ensureAgentDm(
  deps: {
    db: Db;
    relayAdmin: RelayAdmin;
    agentHost?: AgentHostApi | undefined;
    log: AgentRoutesDeps["log"];
  },
  userId: string,
  agent: { id: string; name: string; device_id: string },
): Promise<{ chatId: string; created: boolean } | "missing"> {
  const { db, relayAdmin, agentHost, log } = deps;
  const lockKey = `${userId}:${agent.id}`;
  const prev = dmLocks.get(lockKey) ?? Promise.resolve();
  const run = prev.then(async (): Promise<{ chatId: string; created: boolean } | "missing"> => {
    const [existing] = await db.query<{ id: string }>(
      `select c.id from sa.chats c
           join sa.chat_members me on me.chat_id = c.id and me.member_type = 'user'
             and me.member_id = $1 and me.removed_at is null
           join sa.chat_members ag on ag.chat_id = c.id and ag.member_type = 'agent'
             and ag.member_id = $2 and ag.removed_at is null
           where c.kind = 'dm'
             and (select count(*) from sa.chat_members x where x.chat_id = c.id and x.removed_at is null) = 2
           order by c.created_at, c.id limit 1`,
      [userId, agent.id],
    );
    let chatId = existing?.id;
    const created = !chatId;
    if (!chatId) {
      const devices = await db.query<{ id: string }>(
        "select id from sa.devices where owner_type = 'user' and owner_id = $1",
        [userId],
      );
      if (devices.length === 0) {
        return "missing";
      }
      chatId = randomBytes(12).toString("base64url");
      // Relay first (idempotent): a failure leaves no chat row, so the client can retry.
      for (const d of devices) {
        await relayAdmin.setMember({ chat_id: chatId, device_id: d.id, op: "add" });
      }
      await relayAdmin.setMember({ chat_id: chatId, device_id: agent.device_id, op: "add" });
      // key_epoch 1: the user mints the DM's first key (epoch 1) without a claim.
      await db.query(
        "insert into sa.chats (id, title, kind, created_by, key_epoch) values ($1, $2, 'dm', $3, 1)",
        [chatId, agent.name, userId],
      );
      await db.query(
        "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'user', $2, 'owner'), ($1, 'agent', $3, 'member')",
        [chatId, userId, agent.id],
      );
      log("agent dm created", { chat: chatId, agent: agent.id });
      await agentHost?.onAgentAdded(chatId, agent.id);
    }
    return { chatId, created };
  });
  dmLocks.set(
    lockKey,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRoutesDeps): void {
  const { db, relayAdmin, agentHost, hooks, authenticate, memberGuard, loadChat, log } = deps;

  const agentById = async (id: string): Promise<AgentRow | undefined> =>
    (await db.query<AgentRow>(`${AGENT_SELECT} where a.id = $1`, [id]))[0];

  app.get("/api/agents", async (req, reply): Promise<Agent[] | undefined> => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const workspace = await db.query<AgentRow>(
      `${AGENT_SELECT} where a.scope = 'workspace'
       order by array_position(${ROSTER_ORDER}, a.roster_id), a.id`,
    );
    const mine = await db.query<AgentRow>(
      `${AGENT_SELECT} where a.scope = 'personal' and a.owner_user_id = $1 order by a.created_at, a.id`,
      [userId],
    );
    return [...workspace, ...mine];
  });

  app.post("/api/agents", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const body = CreateAgentRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [clash] = await db.query(
      `select 1 from sa.agents
       where (scope = 'workspace' and lower(name) = lower($1)) or (owner_user_id = $2 and name = $1)`,
      [body.data.name, userId],
    );
    if (clash) return reply.code(409).send({ error: "name_taken" });
    if (!PERSONAL_TEMPLATES.includes(body.data.template)) {
      return reply.code(400).send({ error: "bad_request" });
    }
    await cryptoReady();
    const keys = newDeviceKeys();
    const deviceId = deviceIdFor(keys.publicKey);
    const id = randomBytes(9).toString("base64url");
    const [row] = await db.query<{ id: string }>(
      `insert into sa.agents (id, owner_user_id, name, template, soul) values ($1, $2, $3, $4, $5)
       on conflict (owner_user_id, name) do nothing returning id`,
      [id, userId, body.data.name, body.data.template, body.data.soul],
    );
    if (!row) return reply.code(409).send({ error: "name_taken" });
    await db.query(
      "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1, 'agent', $2, $3)",
      [deviceId, id, keys.publicKey],
    );
    await db.query(
      "insert into sa.agent_devices (device_id, agent_id, enc_secret_key) values ($1, $2, $3)",
      [deviceId, id, encrypt(keys.secretKey)],
    );
    log("agent created", { agent: id, template: body.data.template });
    return agentById(id);
  });

  app.patch("/api/agents/:id", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const body = UpdateAgentRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const agent = await agentById((req.params as { id: string }).id);
    if (!agent || agent.owner_user_id !== userId)
      return reply.code(404).send({ error: "not_found" });
    await db.query("update sa.agents set soul = $1 where id = $2", [body.data.soul, agent.id]);
    log("agent updated", { agent: agent.id });
    await agentHost?.onAgentUpdated?.(agent.id);
    return agentById(agent.id);
  });

  app.post("/api/chats/:id/agents", async (req, reply) => {
    const g = await memberGuard(req, reply, false);
    if (!g) return;
    const body = AddAgentRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const agent = await agentById(body.data.agent_id);
    if (!agent || (agent.scope === "personal" && agent.owner_user_id !== g.userId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    // Personal agents: the owner of both. Workspace agents: any member (the d10 acceptance test
    // requires a non-owner member to add one to a group).
    if (agent.scope === "personal" && g.role !== "owner") {
      return reply.code(403).send({ error: "forbidden" });
    }
    // Relay first (idempotent): a failure leaves the DB untouched and a retry works.
    await relayAdmin.setMember({ chat_id: g.chatId, device_id: agent.device_id, op: "add" });
    await db.query(
      `insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'agent', $2, 'member')
       on conflict (chat_id, member_type, member_id) do update set removed_at = null, joined_at = now(), role = 'member'`,
      [g.chatId, agent.id],
    );
    log("agent added", { chat: g.chatId, agent: agent.id });
    await agentHost?.onAgentAdded(g.chatId, agent.id);
    return loadChat(g.chatId);
  });

  app.delete("/api/chats/:id/agents/:agentId", async (req, reply) => {
    const g = await memberGuard(req, reply, false);
    if (!g) return;
    const agentId = (req.params as { agentId: string }).agentId;
    const [active] = await db.query(
      "select member_id from sa.chat_members where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null",
      [g.chatId, agentId],
    );
    const agent = active ? await agentById(agentId) : undefined;
    if (!agent) return reply.code(404).send({ error: "not_found" });
    // The chat owner may remove any agent; an agent's own owner may remove it; in a room or a
    // group any member may remove a workspace agent (symmetric with adding one, D-10).
    if (g.role !== "owner" && agent.owner_user_id !== g.userId) {
      const [chat] = await db.query<{ kind: string }>("select kind from sa.chats where id = $1", [
        g.chatId,
      ]);
      if (agent.scope === "personal") return reply.code(404).send({ error: "not_found" });
      if (chat?.kind !== "room" && chat?.kind !== "group") {
        return reply.code(403).send({ error: "forbidden" });
      }
    }
    await relayAdmin.setMember({ chat_id: g.chatId, device_id: agent.device_id, op: "remove" });
    await db.query(
      `update sa.chat_members set removed_at = now()
       where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null`,
      [g.chatId, agentId],
    );
    log("agent removed", { chat: g.chatId, agent: agentId });
    await agentHost?.onAgentRemoved(g.chatId, agentId);
    return loadChat(g.chatId);
  });

  app.post("/api/agents/:id/dm", async (req, reply): Promise<Chat | undefined> => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const agent = await agentById((req.params as { id: string }).id);
    if (!agent || (agent.scope === "personal" && agent.owner_user_id !== userId)) {
      await reply.code(404).send({ error: "not_found" });
      return;
    }
    const result = await ensureAgentDm(deps, userId, agent);
    if (result === "missing") {
      await reply.code(409).send({ error: "missing_devices", missing_devices: [userId] });
      return;
    }
    const { chatId, created } = result;
    const dmChat = chatId;
    // Another device of this user may have keyed the DM already, and a key once stored for an
    // epoch is final: a second key for that epoch would leave the agent unable to read the new
    // device. Once the agent holds the current epoch, the answer carries the next one unspent.
    if (!created) {
      await db.query(
        `update sa.chats c set key_epoch = k.top + 1
           from (select max(epoch) as top from sa.agent_chat_keys
                  where device_id = $2 and chat_id = $1) k
          where c.id = $1 and k.top is not null and k.top >= c.key_epoch`,
        [dmChat, agent.device_id],
      );
    }
    void Promise.resolve(hooks?.onAgentDm?.(userId, agent.id, dmChat, created)).catch((e) =>
      log("agent dm hook failed", { agent: agent.id, error: (e as Error).message }),
    );
    return (await loadChat(dmChat)) ?? undefined;
  });
}
