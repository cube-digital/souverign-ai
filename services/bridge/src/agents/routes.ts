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
import { encrypt } from "./secrets.js";

export type AgentHost = {
  onAgentAdded(chatId: string, agentId: string): void | Promise<void>;
  onAgentRemoved(chatId: string, agentId: string): void | Promise<void>;
};

export type AgentRoutesDeps = {
  db: Db;
  relayAdmin: RelayAdmin;
  agentHost?: AgentHost;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<string | null>;
  memberGuard: (
    req: FastifyRequest,
    reply: FastifyReply,
    needOwner: boolean,
  ) => Promise<{ userId: string; chatId: string } | null>;
  loadChat: (chatId: string) => Promise<Chat | null>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
};

type AgentRow = Omit<Agent, "device_id"> & { device_id: string };

const AGENT_SELECT = `select a.id, a.name, a.template, a.soul, a.owner_user_id, a.status, d.device_id
  from sa.agents a join sa.agent_devices d on d.agent_id = a.id`;

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRoutesDeps): void {
  const { db, relayAdmin, agentHost, authenticate, memberGuard, loadChat, log } = deps;

  const agentById = async (id: string): Promise<AgentRow | undefined> =>
    (await db.query<AgentRow>(`${AGENT_SELECT} where a.id = $1`, [id]))[0];

  app.get("/api/agents", async (req, reply): Promise<Agent[] | undefined> => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    return db.query<AgentRow>(
      `${AGENT_SELECT} where a.owner_user_id = $1 order by a.created_at, a.id`,
      [userId],
    );
  });

  app.post("/api/agents", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const body = CreateAgentRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
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
    return agentById(agent.id);
  });

  app.post("/api/chats/:id/agents", async (req, reply) => {
    const g = await memberGuard(req, reply, true);
    if (!g) return;
    const body = AddAgentRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const agent = await agentById(body.data.agent_id);
    if (!agent || agent.owner_user_id !== g.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    // Relay first (idempotent): a failure leaves the DB untouched and a retry works.
    await relayAdmin.setMember({ chat_id: g.chatId, device_id: agent.device_id, op: "add" });
    await db.query(
      `insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'agent', $2, 'member')
       on conflict (chat_id, member_type, member_id) do update set removed_at = null, joined_at = now()`,
      [g.chatId, agent.id],
    );
    log("agent added", { chat: g.chatId, agent: agent.id });
    await agentHost?.onAgentAdded(g.chatId, agent.id);
    return loadChat(g.chatId);
  });

  app.delete("/api/chats/:id/agents/:agentId", async (req, reply) => {
    const g = await memberGuard(req, reply, true);
    if (!g) return;
    const agentId = (req.params as { agentId: string }).agentId;
    const [active] = await db.query(
      "select member_id from sa.chat_members where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null",
      [g.chatId, agentId],
    );
    const agent = active ? await agentById(agentId) : undefined;
    if (!agent) return reply.code(404).send({ error: "not_found" });
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
}
