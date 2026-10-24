import {
  ChatEngine,
  type ChatMessage as EngineMessage,
  RelayClient,
  type RelayLink,
} from "@sa/client";
import { cryptoReady } from "@sa/crypto";
import { type ActivityBody, TICKET_TTL_MS, type TraceStep } from "@sa/protocol";
import { signTicket } from "@sa/protocol/ticket";
import type { Db } from "../db.js";
import { ToolLog } from "../mcp/tool-log.js";
import { waitForRelay } from "../relay-ready.js";
import type { AgentHostApi } from "./api.js";
import { PgKeyStore } from "./pg-keystore.js";
import type { AgentRuntime, ChatMessage, RuntimeAgent } from "./runtime.js";
import { decrypt, encrypt } from "./secrets.js";
import { describeImage } from "./vision.js";

const MIN_GAP_MS = 3000;
const CONTEXT_MESSAGES = 20;
const WRITING_GAP_MS = 400;
const DRAFT_MAX = 8000;
const IMAGE_WINDOW = 5;
const DOWN = "I can't answer right now (the local model is not available).";

export type AgentHostOptions = {
  db: Db;
  runtime: AgentRuntime;
  relayInternalUrl: string;
  adminToken: string;
  toolLog?: ToolLog;
  /** Test seam: replaces the vision model call. */
  describe?: ((bytes: Uint8Array, mime: string, name: string) => Promise<string>) | undefined;
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
  /** the relay link, for the health check */
  link: RelayLink;
  /** last time the link was seen `ready` (or the device was built) */
  lastReadyAt: number;
};

const HEALTH_INTERVAL_MS = 15_000;
const DEAD_AFTER_MS = 30_000;

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: "info", msg, ...extra }));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isImage = (mime: unknown) =>
  typeof mime === "string" && /^image\/(png|jpeg|webp|gif)$/.test(mime);

const formatSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

export class AgentHost implements AgentHostApi {
  private devices = new Map<string, Device>();
  private building = new Map<string, Promise<Device | null>>();
  private toolLog: ToolLog;
  private health: ReturnType<typeof setInterval> | null = null;
  private rebuilding = new Set<string>();

  constructor(private opts: AgentHostOptions) {
    this.toolLog = opts.toolLog ?? new ToolLog();
  }

  /** Starts a device for every agent that is an active member of at least one chat. */
  async start(): Promise<void> {
    const rows = await this.opts.db.query<{ agent_id: string }>(
      "select distinct member_id as agent_id from sa.chat_members where member_type = 'agent' and removed_at is null",
    );
    for (const r of rows) this.prewarm(await this.deviceFor(r.agent_id));
  }

  /** Starts the agent's runtime in the background so the first question does not wait for it. */
  private prewarm(dev: Device | null): void {
    if (!dev) return;
    this.opts.runtime.ensureStarted(dev.agent).catch((e) => {
      log("agent prewarm failed", { agent: dev.agent.id, error: (e as Error).name });
    });
  }

  async onAgentAdded(chatId: string, agentId: string): Promise<void> {
    const dev = await this.deviceFor(agentId);
    await dev?.engine.start([chatId]);
    this.prewarm(dev);
  }

  /** Reloads the agent row and stops its gateway so the next turn writes the new SOUL.md. */
  async onAgentUpdated(agentId: string): Promise<void> {
    const dev = this.devices.get(agentId);
    if (!dev) return;
    const [row] = await this.opts.db.query<{ name: string; template: string; soul: string }>(
      "select name, template, soul from sa.agents where id = $1",
      [agentId],
    );
    if (!row) return;
    dev.agent = { ...dev.agent, name: row.name, template: row.template, soul: row.soul };
    await this.opts.runtime.stop(dev.agent);
  }

  async onAgentRemoved(chatId: string, agentId: string): Promise<void> {
    // Membership is checked on every message, so a removed chat simply stops getting replies.
    this.devices.get(agentId)?.lastReply.delete(chatId);
  }

  /** Every 15 s: a device whose relay link has not been ready for 30 s is closed and rebuilt. */
  private ensureHealthLoop(): void {
    if (this.health) return;
    this.health = setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS);
    this.health.unref?.();
  }

  private async checkHealth(): Promise<void> {
    const now = Date.now();
    for (const [agentId, dev] of [...this.devices]) {
      const status = (dev.link as { status?: string }).status;
      if (status === undefined || status === "ready") {
        dev.lastReadyAt = now;
        continue;
      }
      if (now - dev.lastReadyAt < DEAD_AFTER_MS || this.rebuilding.has(agentId)) continue;
      this.rebuilding.add(agentId);
      try {
        dev.close();
        this.devices.delete(agentId);
        const fresh = await this.deviceFor(agentId);
        if (fresh)
          log("agent device reconnected", { agent: agentId, after_ms: now - dev.lastReadyAt });
      } catch (e) {
        log("agent device rebuild failed", { agent: agentId, error: (e as Error).message });
      } finally {
        this.rebuilding.delete(agentId);
      }
    }
  }

  async stopAll(): Promise<void> {
    if (this.health) clearInterval(this.health);
    this.health = null;
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
      `select a.id, a.name, a.template, a.soul, coalesce(u.display_name, 'the workspace') as owner_name,
         ad.device_id, dv.public_key, ad.enc_secret_key
       from sa.agents a
       left join sa.users u on u.id = a.owner_user_id
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
      // After a machine restart the relay may come up after the bridge: do not give up early.
      await waitForRelay(this.opts.relayInternalUrl);
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
      link,
      lastReadyAt: Date.now(),
    };
    engine.onMessage((m) => void this.onMessage(dev, m));
    this.devices.set(agentId, dev);
    this.ensureHealthLoop();
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
    const describe = this.opts.describe ?? describeImage;
    const { agent } = dev;
    const [member] = await db.query(
      "select 1 from sa.chat_members where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null",
      [chatId, agent.id],
    );
    if (!member) return;
    if (Date.now() - (dev.lastReply.get(chatId) ?? 0) < MIN_GAP_MS) return;

    const started = Date.now();
    // Live signals are sent in order, never block the turn and are safe to lose.
    let signals: Promise<void> = Promise.resolve();
    const signal = (body: ActivityBody) => {
      signals = signals.then(() => dev.engine.sendActivity(chatId, body)).catch(() => {});
    };
    signal({ type: "activity", phase: "thinking" });
    const onTool = (agentId: string, name: string) => {
      if (agentId === agent.id)
        signal({ type: "activity", phase: "tool", tool: name.slice(0, 64) });
    };
    this.toolLog.on("tool", onTool);
    let failed = false;
    let body: { text: string; meta: { tools: string[]; ms: number; trace?: TraceStep[] } };
    try {
      await runtime.ensureStarted(agent);
      const [chat] = await db.query<{ title: string }>("select title from sa.chats where id = $1", [
        chatId,
      ]);
      const recent = await db.query<{
        id: string;
        name: string | null;
        body: Record<string, unknown>;
      }>(
        `select p.id, coalesce(u.display_name, a.name, p.sender_device) as name, p.body
         from sa.messages_plain p
         left join sa.devices d on d.id = p.sender_device
         left join sa.users u on d.owner_type = 'user' and u.id = d.owner_id
         left join sa.agents a on d.owner_type = 'agent' and a.id = d.owner_id
         where p.device_id = $1 and p.chat_id = $2 and p.body->>'type' in ('text', 'file')
         order by p.seq desc limit ${CONTEXT_MESSAGES}`,
        [dev.deviceId, chatId],
      );
      // Newest first; index 0 is the addressing message.
      const imageSteps: TraceStep[] = [];
      for (const r of recent.slice(1, 1 + IMAGE_WINDOW)) {
        const b = r.body;
        if (b.type !== "file" || !isImage(b.mime) || typeof b.description === "string") continue;
        const fname = String(b.name);
        signal({ type: "activity", phase: "tool", tool: "describe_image" });
        const t0 = Date.now();
        let result: string;
        try {
          const bytes = await dev.engine.downloadFile(b as never);
          const description = (await describe(bytes, String(b.mime), fname)).trim();
          if (!description) throw new Error("empty description");
          b.description = description;
          await db.query(
            "update sa.messages_plain set body = body || jsonb_build_object('description', $3::text) where device_id = $1 and id = $2",
            [dev.deviceId, r.id, description],
          );
          result = description;
        } catch (e) {
          log("describe image failed", { agent: agent.id, error: (e as Error).message });
          result = "could not be read";
        }
        imageSteps.push({
          kind: "tool",
          name: "describe_image",
          args: fname.slice(0, 500),
          result: result.slice(0, 1500),
          ms: Date.now() - t0,
        });
      }
      const history = recent.reverse().map((r) => {
        const b = r.body;
        if (b.type !== "file") return `${r.name}: ${b.text}`;
        if (!isImage(b.mime)) return `${r.name}: [file ${b.name}, ${formatSize(Number(b.size))}]`;
        return typeof b.description === "string"
          ? `${r.name}: [image ${b.name}] ${b.description}`
          : `${r.name}: [image ${b.name}, could not be read]`;
      });
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
      this.toolLog.begin(agent.id, chatId);
      let reply: Awaited<ReturnType<AgentRuntime["chat"]>>;
      let steps: TraceStep[];
      try {
        let draft = "";
        let sent = "";
        let lastSent = 0;
        const flush = () => {
          if (draft === sent) return;
          sent = draft;
          lastSent = Date.now();
          signal({ type: "activity", phase: "writing", draft });
        };
        const streamed = runtime.chatStream?.bind(runtime);
        if (!streamed) {
          reply = await runtime.chat(agent, chatId, messages);
        } else
          reply = await streamed(agent, chatId, messages, (t) => {
            draft = (draft + t).slice(0, DRAFT_MAX);
            if (Date.now() - lastSent >= WRITING_GAP_MS) flush();
          });
        flush();
      } finally {
        steps = this.toolLog.end(agent.id);
      }
      const trace: TraceStep[] = [];
      if (reply.reasoning?.trim())
        trace.push({ kind: "thinking", text: reply.reasoning.slice(0, 4000) });
      trace.push(...imageSteps, ...steps);
      body = {
        text: reply.content.slice(0, 8000) || "(no answer)",
        meta: {
          tools: steps.flatMap((s) => (s.kind === "tool" ? [s.name] : [])).slice(0, 20),
          ms: Date.now() - started,
          trace: trace.slice(0, 30),
        },
      };
    } catch (e) {
      log("agent turn failed", {
        agent: agent.id,
        error: (e as Error).name,
        status: (e as { status?: unknown }).status,
      });
      failed = true;
      await db.query("update sa.agents set status = 'error' where id = $1", [agent.id]);
      body = { text: DOWN, meta: { tools: [], ms: Date.now() - started } };
    }
    this.toolLog.off("tool", onTool);
    if (failed) signal({ type: "activity", phase: "error" });
    await signals;
    dev.lastReply.set(chatId, Date.now());
    let sent = true;
    try {
      await dev.engine.sendText(chatId, body.text, body.meta);
      log("agent replied", {
        agent: agent.id,
        chat: chatId,
        ms: body.meta.ms,
        size: body.text.length,
      });
    } catch (e) {
      sent = false;
      log("agent send failed", { agent: agent.id, error: (e as Error).message });
    }
    if (!failed) signal({ type: "activity", phase: sent ? "done" : "error" });
    await signals;
  }
}
