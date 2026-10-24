import {
  ChatEngine,
  type ChatMessage as EngineMessage,
  RelayClient,
  type RelayLink,
} from "@sa/client";
import { cryptoReady } from "@sa/crypto";
import { TICKET_TTL_MS, type TraceStep } from "@sa/protocol";
import { signTicket } from "@sa/protocol/ticket";
import type { Db } from "../db.js";
import { ToolLog } from "../mcp/tool-log.js";
import { PgKeyStore } from "./pg-keystore.js";
import type { AgentRuntime, ChatMessage, RuntimeAgent } from "./runtime.js";
import { decrypt, encrypt } from "./secrets.js";

const MIN_GAP_MS = 3000;
const CONTEXT_MESSAGES = 20;
const DOWN = "I can't answer right now (the local model is not available).";

export type AgentHostOptions = {
  db: Db;
  runtime: AgentRuntime;
  relayInternalUrl: string;
  adminToken: string;
  toolLog?: ToolLog;
  /** Test seam: replaces the websocket client. */
  linkFactory?: (deviceId: string) => RelayLink;
};

type Device = {
  agent: RuntimeAgent;
  deviceId: string;
  engine: ChatEngine;
  close: () => void;
  lastReply: Map<string, number>;
  turns: Promise<void>;
};

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: "info", msg, ...extra }));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class AgentHost {
  private devices = new Map<string, Device>();
  private building = new Map<string, Promise<Device | null>>();
  private toolLog: ToolLog;

  constructor(private opts: AgentHostOptions) {
    this.toolLog = opts.toolLog ?? new ToolLog();
  }

  /** Starts a device for every agent that is an active member of at least one chat. */
  async start(): Promise<void> {
    const rows = await this.opts.db.query<{ agent_id: string }>(
      "select distinct member_id as agent_id from sa.chat_members where member_type = 'agent' and removed_at is null",
    );
    for (const r of rows) await this.deviceFor(r.agent_id);
  }

  async onAgentAdded(chatId: string, agentId: string): Promise<void> {
    const dev = await this.deviceFor(agentId);
    await dev?.engine.start([chatId]);
  }

  async onAgentRemoved(chatId: string, agentId: string): Promise<void> {
    // Membership is checked on every message, so a removed chat simply stops getting replies.
    this.devices.get(agentId)?.lastReply.delete(chatId);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.building.values());
    for (const d of this.devices.values()) d.close();
    this.devices.clear();
    this.building.clear();
    await this.opts.runtime.stopAll();
  }

  private deviceFor(agentId: string): Promise<Device | null> {
    const have = this.devices.get(agentId);
    if (have) return Promise.resolve(have);
    let p = this.building.get(agentId);
    if (!p) {
      p = this.build(agentId).finally(() => this.building.delete(agentId));
      this.building.set(agentId, p);
    }
    return p;
  }

  private async build(agentId: string): Promise<Device | null> {
    const { db, adminToken } = this.opts;
    await cryptoReady();
    const [row] = await db.query<{
      id: string;
      name: string;
      template: string;
      soul: string;
      owner_name: string;
      device_id: string;
      public_key: string;
      enc_secret_key: string;
    }>(
      `select a.id, a.name, a.template, a.soul, u.display_name as owner_name,
         ad.device_id, dv.public_key, ad.enc_secret_key
       from sa.agents a
       join sa.users u on u.id = a.owner_user_id
       join sa.agent_devices ad on ad.agent_id = a.id
       join sa.devices dv on dv.id = ad.device_id
       where a.id = $1`,
      [agentId],
    );
    if (!row) return null;
    const agent: RuntimeAgent = {
      id: row.id,
      name: row.name,
      template: row.template,
      soul: row.soul,
      ownerName: row.owner_name,
    };
    const device = {
      deviceId: row.device_id,
      keys: { publicKey: row.public_key, secretKey: decrypt(row.enc_secret_key) },
    };
    const store = new PgKeyStore(db, device, { encrypt, decrypt });

    let link: RelayLink;
    let close = () => {};
    let connecting: Promise<unknown> = Promise.resolve();
    if (this.opts.linkFactory) {
      link = this.opts.linkFactory(row.device_id);
    } else {
      const url = `${this.opts.relayInternalUrl.replace(/^http/, "ws").replace(/\/$/, "")}/relay/ws`;
      const client = new RelayClient({
        url,
        deviceId: row.device_id,
        getTicket: async () => signTicket(adminToken, row.device_id, TICKET_TTL_MS).ticket,
      });
      link = client;
      close = () => client.close();
      connecting = Promise.race([
        client.connect(),
        new Promise((r) => setTimeout(r, 10_000)),
      ]).catch(() => {});
    }

    const engine = new ChatEngine({
      link,
      store,
      device,
      isTrustedKeySender: async (chatId, sender) => {
        const rows = await db.query(
          `select d.id from sa.devices d
           join sa.chat_members m on m.member_type = 'user' and m.member_id = d.owner_id
           where d.owner_type = 'user' and d.id = $1 and m.chat_id = $2 and m.removed_at is null`,
          [sender, chatId],
        );
        return rows.length > 0;
      },
    });
    const dev: Device = {
      agent,
      deviceId: row.device_id,
      engine,
      close,
      lastReply: new Map(),
      turns: Promise.resolve(),
    };
    engine.onMessage((m) => void this.onMessage(dev, m));
    this.devices.set(agentId, dev);
    await connecting;
    const chats = await db.query<{ chat_id: string }>(
      "select chat_id from sa.chat_members where member_type = 'agent' and member_id = $1 and removed_at is null",
      [agentId],
    );
    await engine.start(chats.map((c) => c.chat_id));
    log("agent device started", { agent: agentId, chats: chats.length });
    return dev;
  }

  private async onMessage(dev: Device, m: EngineMessage): Promise<void> {
    try {
      if (m.status !== "ok" || !m.body) return;
      const { db } = this.opts;
      // Every message is stored once; a replay of a known message never triggers a reply.
      const fresh = await db.query<{ id: string }>(
        `insert into sa.messages_plain (device_id, chat_id, id, seq, sender_device, epoch, body, ts)
         values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8)
         on conflict (device_id, id) do nothing returning id`,
        [
          dev.deviceId,
          m.chatId,
          m.id,
          m.seq,
          m.senderDevice,
          m.epoch,
          JSON.stringify(m.body),
          m.ts,
        ],
      );
      if (fresh.length === 0) return;
      if (m.body.type !== "text" || m.senderDevice === dev.deviceId) return;
      const text = m.body.text;
      if (!new RegExp(`@${escapeRe(dev.agent.name)}(?![\\p{L}\\p{N}_])`, "iu").test(text)) return;
      dev.turns = dev.turns.then(() => this.turn(dev, m.chatId, text)).catch(() => {});
    } catch (e) {
      log("agent message failed", { agent: dev.agent.id, error: (e as Error).message });
    }
  }

  private async turn(dev: Device, chatId: string, text: string): Promise<void> {
    const { db, runtime } = this.opts;
    const { agent } = dev;
    const [member] = await db.query(
      "select 1 from sa.chat_members where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null",
      [chatId, agent.id],
    );
    if (!member) return;
    if (Date.now() - (dev.lastReply.get(chatId) ?? 0) < MIN_GAP_MS) return;

    const started = Date.now();
    let body: { text: string; meta: { tools: string[]; ms: number; trace?: TraceStep[] } };
    try {
      await runtime.ensureStarted(agent);
      const [chat] = await db.query<{ title: string }>("select title from sa.chats where id = $1", [
        chatId,
      ]);
      const recent = await db.query<{ name: string | null; text: string }>(
        `select coalesce(u.display_name, a.name, p.sender_device) as name, p.body->>'text' as text
         from sa.messages_plain p
         left join sa.devices d on d.id = p.sender_device
         left join sa.users u on d.owner_type = 'user' and u.id = d.owner_id
         left join sa.agents a on d.owner_type = 'agent' and a.id = d.owner_id
         where p.device_id = $1 and p.chat_id = $2 and p.body->>'type' = 'text'
         order by p.seq desc limit ${CONTEXT_MESSAGES}`,
        [dev.deviceId, chatId],
      );
      const history = recent.reverse().map((r) => `${r.name}: ${r.text}`);
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: [
            `You are ${agent.name} in the chat "${chat?.title ?? ""}" (chat_id ${chatId}). Messages you can see, oldest first:`,
            ...history,
          ].join("\n"),
        },
        { role: "user", content: text },
      ];
      this.toolLog.begin(agent.id);
      let reply: Awaited<ReturnType<AgentRuntime["chat"]>>;
      let steps: TraceStep[];
      try {
        reply = await runtime.chat(agent, chatId, messages);
      } finally {
        steps = this.toolLog.end(agent.id);
      }
      const trace: TraceStep[] = [];
      if (reply.reasoning?.trim())
        trace.push({ kind: "thinking", text: reply.reasoning.slice(0, 4000) });
      trace.push(...steps);
      body = {
        text: reply.content.slice(0, 8000) || "(no answer)",
        meta: {
          tools: steps.flatMap((s) => (s.kind === "tool" ? [s.name] : [])).slice(0, 20),
          ms: Date.now() - started,
          trace: trace.slice(0, 30),
        },
      };
    } catch (e) {
      log("agent turn failed", { agent: agent.id, error: (e as Error).message });
      await db.query("update sa.agents set status = 'error' where id = $1", [agent.id]);
      body = { text: DOWN, meta: { tools: [], ms: Date.now() - started } };
    }
    dev.lastReply.set(chatId, Date.now());
    try {
      await dev.engine.sendText(chatId, body.text, body.meta);
      log("agent replied", {
        agent: agent.id,
        chat: chatId,
        ms: body.meta.ms,
        size: body.text.length,
      });
    } catch (e) {
      log("agent send failed", { agent: agent.id, error: (e as Error).message });
    }
  }
}
