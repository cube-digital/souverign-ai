import {
  ChatEngine,
  type ChatMessage as EngineMessage,
  RelayClient,
  type RelayLink,
} from "@sa/client";
import { cryptoReady, randomId } from "@sa/crypto";
import {
  type ActivityBody,
  MAX_VOICE_MS,
  type MessageBody,
  type TextMeta,
  TICKET_TTL_MS,
  type TraceStep,
  type TurnTrigger,
  type VoiceLatency,
} from "@sa/protocol";
import { signTicket } from "@sa/protocol/ticket";
import { publish } from "../approvals/events.js";
import type { Db } from "../db.js";
import { ToolLog } from "../mcp/tool-log.js";
import { waitForRelay } from "../relay-ready.js";
import { type AudioClient, audioClientFromEnv, ttsLanguage } from "../voice/audio-client.js";
import { Speaker } from "../voice/voice-turn.js";
import { ACCESS_RE, accessSummary, agentTools } from "./access.js";
import type { AgentHostApi, ProactiveRequest, StopResult } from "./api.js";
import { postIntro } from "./intro.js";
import { markReask, recordTurn, setFeedback, type TurnOutcome } from "./metrics.js";
import { PgKeyStore } from "./pg-keystore.js";
import {
  type AgentRuntime,
  abortError,
  type ChatMessage,
  type RuntimeAgent,
  splitThink,
} from "./runtime.js";
import { decrypt, encrypt } from "./secrets.js";
import {
  beginTurn,
  endTurn,
  hasBeforeReplyHooks,
  runBeforeReply,
  runStored,
  type TurnContext,
} from "./turn-hooks.js";
import { forceFirstTool, setForceFirstTool } from "./turn-policy.js";
import { type Priority, TurnQueue } from "./turn-queue.js";
import { describeImage } from "./vision.js";
import { addressesAgent, claimVoice } from "./voice-trigger.js";

const MIN_GAP_MS = 3000;
const CONTEXT_MESSAGES = 20;
const WRITING_GAP_MS = 400;
const DRAFT_MAX = 8000;
const IMAGE_WINDOW = 5;
const THREAD_REPLIES = 10;
const DOWN = "I can't answer right now (the local model is not available).";
const LIMIT =
  "I stopped after 3 minutes without finishing. I can only read through my tools and cannot create files or run commands. Try a narrower question.";
/** Older envelopes are seeded history or replays and never trigger a turn. */
const TRIGGER_MAX_AGE_MS = 5 * 60_000;
/** How long the same person may follow up in a thread without a tag. */
const FOLLOWUP_MS = 10 * 60_000;
const KEY_WAIT_MS = 30_000;
const COMPLETE_TIMEOUT_MS = 180_000;
const STT_FAILED = "I couldn't transcribe that voice message.";
const DONE_EMOJI = { done: "✅", stopped: "⏹️", error: "⚠️" } as const;

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
  /** Speech-to-text and text-to-speech; defaults to the audio-api from the environment. */
  audio?: AudioClient | null;
};

type Device = {
  agent: RuntimeAgent;
  deviceId: string;
  engine: ChatEngine;
  close: () => void;
  /** the relay link, for the health check */
  link: RelayLink;
  /** last time the link was seen `ready` (or the device was built) */
  lastReadyAt: number;
};

/** What a voice turn adds: the reply is also spoken. */
type VoiceTurn = {
  audio: AudioClient;
  /** TTS language, from the language STT detected */
  language: string;
  /** the user's voice message */
  sourceId: string;
  /** when the bridge received the voice message */
  receivedAt: number;
  sttMs: number;
};

/** One turn, from its trigger to the final reply. */
type Turn = {
  id: string;
  agentId: string;
  chatId: string;
  trigger: TurnTrigger;
  /** what the agent is asked: the trigger message text, or the proactive prompt */
  text: string;
  /** whether the first model round must call a tool (bug 4) */
  force: boolean;
  /** the trigger message; reactions go on it. Absent for proactive turns. */
  messageId?: string;
  /** seq of the trigger message; the chat context ends there */
  seq?: number;
  /** thread root the reply goes to; absent for a top-level reply */
  replyTo?: string;
  /** owner of the verified sender device, never taken from text or tool args */
  requesterUserId?: string;
  requesterName?: string;
  /** retry after a denied private preview: recall must skip taught knowledge */
  noTaught?: boolean;
  /** set for turns that answer a voice message */
  voice?: VoiceTurn;
  abort: AbortController;
  stoppedBy?: string;
  /** the 👀 reaction, so the final reactions are sent after it */
  eyes: Promise<void>;
  started: number;
  priority: Priority;
  /** ms from the trigger until 👀 was sent */
  eyesMs?: number;
};

type TurnSeed = Omit<
  Turn,
  "id" | "agentId" | "abort" | "eyes" | "started" | "stoppedBy" | "priority" | "eyesMs"
>;

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
  /** Turns that can still be stopped, by turn id. */
  private turns = new Map<string, Turn>();
  /** "chat|root" → the agent that last answered in that thread, whom it answered, and until when
   * that person may follow up without a tag. Shared by every agent device. */
  private threadOwner = new Map<string, { agentId: string; userId: string; until: number }>();
  /** One queue for every agent: the model can only serve a few turns at once. */
  private queue = new TurnQueue();
  /** "agent|chat" → when the agent last replied there; kept here so a device rebuild keeps it. */
  private lastReplyAt = new Map<string, number>();
  /** Message handlers in flight; stopAll waits for them so the database can close cleanly. */
  private handling = new Set<Promise<void>>();
  private audioClient: AudioClient | null | undefined;
  private voiceDisabledLogged = false;

  constructor(private opts: AgentHostOptions) {
    this.toolLog = opts.toolLog ?? new ToolLog();
  }

  private audio(): AudioClient | null {
    if (this.audioClient === undefined) this.audioClient = this.opts.audio ?? audioClientFromEnv();
    return this.audioClient;
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
    if (dev) {
      // Waits for the chat key, so it never blocks the add-agent request.
      void postIntro({
        db: this.opts.db,
        engine: dev.engine,
        agent: dev.agent,
        chatId,
        alive: () => this.devices.get(agentId) === dev,
        afterTurns: (post) =>
          this.queue.enqueue(post, "proactive", undefined, { agentId, requester: "intro" }),
      }).catch((e) => {
        log("agent intro failed", { agent: agentId, error: (e as Error).message });
      });
    }
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
    dev.agent = {
      ...dev.agent,
      name: row.name,
      template: row.template,
      soul: row.soul,
      lessons: await this.lessonsOf(agentId),
    };
    await this.opts.runtime.stop(dev.agent);
  }

  async onAgentRemoved(chatId: string, agentId: string): Promise<void> {
    // Membership is checked on every message, so a removed chat simply stops getting replies.
    this.lastReplyAt.delete(`${agentId}|${chatId}`);
    // A turn in flight in the chat the agent left is stopped, not left to answer.
    for (const turn of this.turns.values()) {
      if (turn.agentId === agentId && turn.chatId === chatId) {
        turn.stoppedBy = "the workspace";
        turn.abort.abort();
      }
    }
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
    await Promise.allSettled([...this.handling]);
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

  private async lessonsOf(agentId: string): Promise<{ text: string; by: string | null }[]> {
    return this.opts.db.query<{ text: string; by: string | null }>(
      `select l.text, u.display_name as by from sa.agent_lessons l
       left join sa.users u on u.id = l.taught_by
       where l.agent_id = $1 order by l.created_at`,
      [agentId],
    );
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
      lessons: await this.lessonsOf(row.id),
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
      isTrustedKeySender: async (chatId, sender, epoch) => {
        // Only an epoch the bridge handed out (claimed) can carry a key; key_epoch 0 is a legacy
        // chat that never saw a claim, so it is not bounded until its first claim.
        const rows = await db.query(
          `select d.id from sa.devices d
           join sa.chat_members m on m.member_type = 'user' and m.member_id = d.owner_id
           join sa.chats c on c.id = m.chat_id
           where d.owner_type = 'user' and d.id = $1 and m.chat_id = $2 and m.removed_at is null
             and ($3::int is null or c.key_epoch = 0 or $3::int <= c.key_epoch)`,
          [sender, chatId, epoch ?? null],
        );
        return rows.length > 0;
      },
    });
    const dev: Device = {
      agent,
      deviceId: row.device_id,
      engine,
      close,
      link,
      lastReadyAt: Date.now(),
    };
    engine.onMessage((m) => {
      const p = this.onMessage(dev, m).finally(() => this.handling.delete(p));
      this.handling.add(p);
    });
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
    const receivedAt = Date.now();
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
      const body = m.body;
      runStored(
        {
          agentId: dev.agent.id,
          deviceId: dev.deviceId,
          chatId: m.chatId,
          id: m.id,
          seq: m.seq,
          senderDevice: m.senderDevice,
          body,
          ts: m.ts,
          receivedAt: Date.now(),
          ...(body.type === "file" ? { loadFile: () => this.fileBytes(dev, body) } : {}),
        },
        log,
      );
      if (m.body.type === "reaction") {
        await this.onReaction(dev, m, m.body);
        return;
      }
      if (m.body.type === "file" && m.body.voice && m.senderDevice !== dev.deviceId) {
        await this.voiceMessage(dev, m, m.body, receivedAt);
        return;
      }
      if (m.body.type !== "text" || m.senderDevice === dev.deviceId) return;
      const seed = await this.triggerFor(dev, m, m.body);
      if (!seed) return;
      if (ACCESS_RE.test(seed.text)) {
        await this.queue.limit(seed.requesterUserId ?? "", () => this.answerAccess(dev, seed));
        return;
      }
      const turn = this.newTurn(dev, seed, "human");
      await this.noteReask(turn);
      void this.runTurn(dev, turn).catch(() => {});
    } catch (e) {
      log("agent message failed", { agent: dev.agent.id, error: (e as Error).message });
    }
  }

  /** Downloads and decrypts the blob of a file body. */
  private fileBytes(
    dev: Device,
    body: Extract<MessageBody, { type: "file" }>,
  ): Promise<Uint8Array> {
    return dev.engine.downloadFile(body);
  }

  /** The active human member who owns the sending device, or null (agents never trigger). */
  private async humanSender(
    m: EngineMessage,
  ): Promise<{ owner_id: string; display_name: string | null } | null> {
    const [sender] = await this.opts.db.query<{ owner_id: string; display_name: string | null }>(
      `select d.owner_id, u.display_name from sa.devices d
       join sa.users u on u.id = d.owner_id and u.kind = 'person'
       join sa.chat_members cm on cm.chat_id = $2 and cm.member_type = 'user'
         and cm.member_id = d.owner_id and cm.removed_at is null
       where d.id = $1 and d.owner_type = 'user'`,
      [m.senderDevice, m.chatId],
    );
    return sender ?? null;
  }

  /**
   * A voice message from a person. Every agent device sees it, one device wins the claim,
   * transcribes it and picks the agent that answers (DM, addressed by name, or thread owner).
   */
  private async voiceMessage(
    dev: Device,
    m: EngineMessage,
    body: Extract<MessageBody, { type: "file" }>,
    receivedAt: number,
  ): Promise<void> {
    const audio = this.audio();
    if (!audio) {
      if (!this.voiceDisabledLogged) {
        this.voiceDisabledLogged = true;
        log("voice disabled");
      }
      return;
    }
    // Checked before the file is downloaded or decoded.
    if (!body.voice || body.voice.duration_ms > MAX_VOICE_MS) return;
    if (Date.now() - m.ts > TRIGGER_MAX_AGE_MS) return;
    const sender = await this.humanSender(m);
    if (!sender) return;
    const { db } = this.opts;
    const [me] = await db.query(
      "select 1 from sa.chat_members where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null",
      [m.chatId, dev.agent.id],
    );
    if (!me) return;
    if (!claimVoice(m.id)) return;

    let transcript: { text: string; language: string };
    try {
      const bytes = await dev.engine.downloadFile(body);
      transcript = await audio.transcribe(bytes, body.name, "auto");
    } catch (e) {
      log("voice stt failed", { agent: dev.agent.id, chat: m.chatId, error: (e as Error).message });
      try {
        await dev.engine.sendReaction(m.chatId, m.id, DONE_EMOJI.error, "add");
        await dev.engine.sendText(
          m.chatId,
          STT_FAILED,
          { local: true },
          {
            replyTo: body.reply_to ?? m.id,
          },
        );
      } catch (e2) {
        log("voice reply failed", { agent: dev.agent.id, error: (e2 as Error).message });
      }
      return;
    }
    const sttMs = Date.now() - receivedAt;
    const text = transcript.text.slice(0, 8000);
    log("voice transcribed", { chat: m.chatId, message: m.id, size: text.length, ms: sttMs });
    if (!text) return;

    const [chat] = await db.query<{ kind: string; users: number; agents: number }>(
      `select c.kind,
         count(*) filter (where m.member_type = 'user')::int as users,
         count(*) filter (where m.member_type = 'agent')::int as agents
       from sa.chats c join sa.chat_members m on m.chat_id = c.id and m.removed_at is null
       where c.id = $1 group by c.kind`,
      [m.chatId],
    );
    const agents = await db.query<{ id: string; name: string }>(
      `select a.id, a.name from sa.chat_members cm join sa.agents a on a.id = cm.member_id
       where cm.chat_id = $1 and cm.member_type = 'agent' and cm.removed_at is null
       order by cm.joined_at, a.id`,
      [m.chatId],
    );
    const thread = body.reply_to;
    let pick: { agentId: string; trigger: TurnTrigger; replyTo?: string; force: boolean } | null =
      null;
    if (chat?.kind === "dm" && Number(chat.users) === 1 && Number(chat.agents) === 1 && agents[0]) {
      pick = thread
        ? { agentId: agents[0].id, trigger: "dm", replyTo: thread, force: false }
        : { agentId: agents[0].id, trigger: "dm", force: true };
    } else {
      const named = agents.find((a) => addressesAgent(text, a.name));
      if (named) {
        pick = { agentId: named.id, trigger: "mention", replyTo: thread ?? m.id, force: true };
      } else if (thread) {
        const owner = this.threadOwner.get(`${m.chatId}|${thread}`);
        if (
          owner &&
          owner.userId === sender.owner_id &&
          Date.now() <= owner.until &&
          agents.some((a) => a.id === owner.agentId)
        ) {
          pick = { agentId: owner.agentId, trigger: "followup", replyTo: thread, force: false };
        }
      }
    }
    if (!pick) return;
    const answering = this.devices.get(pick.agentId) ?? (await this.deviceFor(pick.agentId));
    if (!answering) return;

    const seed: TurnSeed = {
      chatId: m.chatId,
      text,
      messageId: m.id,
      seq: m.seq,
      requesterUserId: sender.owner_id,
      requesterName: sender.display_name ?? sender.owner_id,
      trigger: pick.trigger,
      force: pick.force,
      ...(pick.replyTo ? { replyTo: pick.replyTo } : {}),
      voice: {
        audio,
        language: ttsLanguage(transcript.language),
        sourceId: m.id,
        receivedAt,
        sttMs,
      },
    };
    if (ACCESS_RE.test(text)) {
      await this.queue.limit(seed.requesterUserId ?? "", () => this.answerAccess(answering, seed));
      return;
    }
    const turn = this.newTurn(answering, seed, "human");
    try {
      await answering.engine.sendText(
        m.chatId,
        text,
        { transcript_of: m.id, local: true },
        pick.replyTo ? { replyTo: pick.replyTo } : undefined,
      );
    } catch (e) {
      log("voice transcript send failed", { agent: pick.agentId, error: (e as Error).message });
    }
    await this.noteReask(turn);
    void this.runTurn(answering, turn).catch(() => {});
  }

  /** The answer rules (Decisions, in order). Null when this agent should stay quiet. */
  private async triggerFor(
    dev: Device,
    m: EngineMessage,
    body: Extract<MessageBody, { type: "text" }>,
  ): Promise<TurnSeed | null> {
    const { db } = this.opts;
    // 1. Only people trigger turns: agent devices never do, which prevents loops.
    const sender = await this.humanSender(m);
    if (!sender) return null;
    // 2. Seeded history and replays are older than 5 minutes.
    if (Date.now() - m.ts > TRIGGER_MAX_AGE_MS) return null;
    const [chat] = await db.query<{ kind: string; users: number; agents: number; me: boolean }>(
      `select c.kind,
         count(*) filter (where m.member_type = 'user')::int as users,
         count(*) filter (where m.member_type = 'agent')::int as agents,
         bool_or(m.member_type = 'agent' and m.member_id = $2) as me
       from sa.chats c join sa.chat_members m on m.chat_id = c.id and m.removed_at is null
       where c.id = $1 group by c.kind`,
      [m.chatId, dev.agent.id],
    );
    if (!chat?.me) return null;
    const base = {
      chatId: m.chatId,
      text: body.text,
      messageId: m.id,
      seq: m.seq,
      requesterUserId: sender.owner_id,
      requesterName: sender.display_name ?? sender.owner_id,
    };
    const thread = body.reply_to;
    // 3. In a DM with exactly one person, every message is for the agent.
    if (chat.kind === "dm" && Number(chat.users) === 1 && Number(chat.agents) === 1) {
      return thread
        ? { ...base, trigger: "dm", replyTo: thread, force: false }
        : { ...base, trigger: "dm", force: true };
    }
    // 4. A tag is answered in the thread under the message (or the thread it is in).
    if (mentions(dev.agent.name, body.text))
      return { ...base, trigger: "mention", replyTo: thread ?? m.id, force: true };
    // 5. An untagged reply wakes only the agent that last answered this person in the thread.
    if (!thread) return null;
    const owner = this.threadOwner.get(`${m.chatId}|${thread}`);
    if (owner?.agentId !== dev.agent.id || owner.userId !== sender.owner_id) return null;
    if (Date.now() > owner.until) return null;
    const agents = await db.query<{ name: string }>(
      `select a.name from sa.chat_members m join sa.agents a on a.id = m.member_id
       where m.chat_id = $1 and m.member_type = 'agent' and m.removed_at is null`,
      [m.chatId],
    );
    if (agents.some((a) => mentions(a.name, body.text))) return null;
    return { ...base, trigger: "followup", replyTo: thread, force: false };
  }

  /** Registers a stoppable turn and puts 👀 on its trigger message right away. */
  private newTurn(dev: Device, seed: TurnSeed, priority: Priority): Turn {
    const turn: Turn = {
      ...seed,
      id: randomId(),
      agentId: dev.agent.id,
      abort: new AbortController(),
      eyes: Promise.resolve(),
      started: Date.now(),
      priority,
    };
    this.turns.set(turn.id, turn);
    if (turn.messageId) {
      turn.eyes = this.react(dev, turn, "👀", "add").then(() => {
        turn.eyesMs = Date.now() - turn.started;
      });
    }
    return turn;
  }

  /** A new question from the same person in the same thread flags their previous answer. */
  private async noteReask(turn: Turn): Promise<void> {
    if (!turn.messageId || !turn.requesterUserId) return;
    try {
      await markReask(this.opts.db, {
        turnId: turn.id,
        agentId: turn.agentId,
        chatId: turn.chatId,
        threadRoot: turn.replyTo ?? null,
        requesterUserId: turn.requesterUserId,
      });
    } catch (e) {
      log("turn metrics failed", { agent: turn.agentId, error: (e as Error).message });
    }
  }

  /** 👍/👎 from a person on this agent's own reply is feedback on that turn. */
  private async onReaction(
    dev: Device,
    m: EngineMessage,
    body: Extract<MessageBody, { type: "reaction" }>,
  ): Promise<void> {
    if (m.senderDevice === dev.deviceId) return;
    const { db } = this.opts;
    const [human] = await db.query(
      "select 1 from sa.devices where id = $1 and owner_type = 'user'",
      [m.senderDevice],
    );
    if (!human) return;
    await setFeedback(db, {
      deviceId: dev.deviceId,
      chatId: m.chatId,
      target: body.target,
      emoji: body.emoji,
      op: body.op,
    });
  }

  private async react(dev: Device, turn: Turn, emoji: string, op: "add" | "remove") {
    if (!turn.messageId) return;
    try {
      await dev.engine.sendReaction(turn.chatId, turn.messageId, emoji, op);
    } catch (e) {
      log("agent reaction failed", { agent: dev.agent.id, error: (e as Error).message });
    }
  }

  /** Only the person who triggered a turn can stop it; proactive turns without one cannot be. */
  stopTurn(turnId: string, userId: string): StopResult {
    const turn = this.turns.get(turnId);
    if (!turn) return "not_found";
    if (!turn.requesterUserId || turn.requesterUserId !== userId) return "forbidden";
    turn.stoppedBy = turn.requesterName ?? userId;
    this.turns.delete(turnId);
    turn.abort.abort();
    log("agent turn stop requested", { agent: turn.agentId, turn: turnId });
    return "stopped";
  }

  /** One unprompted turn, posted top-level once the agent holds the chat key. */
  async runProactive(req: ProactiveRequest): Promise<boolean> {
    const { db } = this.opts;
    const dev = await this.deviceFor(req.agentId);
    if (!dev) return false;
    const [member] = await db.query(
      "select 1 from sa.chat_members where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null",
      [req.chatId, req.agentId],
    );
    if (!member) return false;
    const deadline = Date.now() + KEY_WAIT_MS;
    while ((await dev.engine.latestEpoch(req.chatId)) <= 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
    let requester = {};
    if (req.requesterUserId) {
      const [u] = await db.query<{ display_name: string }>(
        "select display_name from sa.users where id = $1",
        [req.requesterUserId],
      );
      requester = {
        requesterUserId: req.requesterUserId,
        requesterName: u?.display_name ?? req.requesterUserId,
      };
    }
    const human = req.kind === "retry" || req.kind === "answer";
    const turn = this.newTurn(
      dev,
      {
        chatId: req.chatId,
        trigger: req.kind,
        text: req.prompt,
        force: true,
        ...(req.replyTo ? { replyTo: req.replyTo } : {}),
        ...(req.noTaught ? { noTaught: true } : {}),
        ...requester,
      },
      human ? "human" : "proactive",
    );
    return this.runTurn(dev, turn).catch(() => false);
  }

  /** Posts as the agent when it is an active member and holds a chat key. */
  async postAs(
    agentId: string,
    chatId: string,
    text: string,
    opts: { replyTo?: string | null; meta?: TextMeta } = {},
  ): Promise<string | null> {
    const dev = await this.deviceFor(agentId);
    if (!dev) return null;
    const [member] = await this.opts.db.query(
      "select 1 from sa.chat_members where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null",
      [chatId, agentId],
    );
    if (!member || (await dev.engine.latestEpoch(chatId)) <= 0) return null;
    try {
      return await dev.engine.sendText(chatId, text, opts.meta, {
        ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      });
    } catch (e) {
      log("agent post failed", { agent: agentId, error: (e as Error).message });
      return null;
    }
  }

  /** Sends one message from the agent's own device; resolves the message id. */
  async sendAs(agentId: string, chatId: string, body: MessageBody): Promise<string> {
    const dev = await this.deviceFor(agentId);
    if (!dev) throw new Error("agent_not_ready");
    // the chat key may still be on its way to a freshly added agent
    const deadline = Date.now() + KEY_WAIT_MS;
    while ((await dev.engine.latestEpoch(chatId)) <= 0) {
      if (Date.now() >= deadline) throw new Error("agent_not_ready");
      await new Promise((r) => setTimeout(r, 100));
    }
    return dev.engine.sendMessage(chatId, body);
  }

  /**
   * One tool-less background completion on the shared queue, behind every human turn. The forced
   * first tool is off for the call and restored afterwards.
   */
  async complete(agentId: string, sessionKey: string, messages: ChatMessage[]): Promise<string> {
    const dev = await this.deviceFor(agentId);
    if (!dev) throw new Error("agent_not_ready");
    const { runtime } = this.opts;
    return this.queue.enqueue(
      async () => {
        const agent = (this.devices.get(agentId) ?? dev).agent;
        const previous = forceFirstTool(agentId);
        setForceFirstTool(agentId, false);
        const limit = new AbortController();
        const timer = setTimeout(
          () => limit.abort(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
          COMPLETE_TIMEOUT_MS,
        );
        try {
          await runtime.ensureStarted(agent);
          const r = await runtime.chat(agent, sessionKey, messages, { signal: limit.signal });
          return splitThink(r.content).content;
        } finally {
          clearTimeout(timer);
          setForceFirstTool(agentId, previous);
        }
      },
      "proactive",
      undefined,
      { agentId, requester: sessionKey },
    );
  }

  /** "What can you access here?" is answered by the bridge from facts, never by the model. */
  private async answerAccess(dev: Device, seed: TurnSeed): Promise<void> {
    const { db } = this.opts;
    const started = Date.now();
    const [row] = await db.query<{
      title: string;
      joined_at: string | Date;
      roster_id: string | null;
      template: string;
    }>(
      `select c.title, m.joined_at, a.roster_id, a.template
       from sa.chats c
       join sa.chat_members m on m.chat_id = c.id and m.member_type = 'agent'
         and m.member_id = $2 and m.removed_at is null
       join sa.agents a on a.id = m.member_id
       where c.id = $1`,
      [seed.chatId, dev.agent.id],
    );
    if (!row) return;
    const [count] = await db.query<{ n: number }>(
      `select count(*)::int as n from sa.messages_plain
       where device_id = $1 and chat_id = $2 and body->>'type' in ('text', 'file')`,
      [dev.deviceId, seed.chatId],
    );
    const text = accessSummary({
      agentName: dev.agent.name,
      chatTitle: row.title,
      joinedAt: new Date(row.joined_at),
      seen: Number(count?.n ?? 0),
      tools: agentTools(row.roster_id, row.template),
    });
    const meta: TextMeta = { trigger: "access", local: true, ms: Date.now() - started };
    this.claimThread(dev, seed);
    try {
      await dev.engine.sendText(
        seed.chatId,
        text,
        meta,
        seed.replyTo ? { replyTo: seed.replyTo } : undefined,
      );
      log("agent access answered", { agent: dev.agent.id, chat: seed.chatId });
    } catch (e) {
      log("agent send failed", { agent: dev.agent.id, error: (e as Error).message });
    }
  }

  /** This agent now owns the thread for untagged follow-ups from the same person. */
  private claimThread(
    dev: Device,
    t: { chatId: string; replyTo?: string; requesterUserId?: string },
  ) {
    if (!t.replyTo || !t.requesterUserId) return;
    const now = Date.now();
    for (const [k, v] of this.threadOwner) if (v.until < now) this.threadOwner.delete(k);
    this.threadOwner.set(`${t.chatId}|${t.replyTo}`, {
      agentId: dev.agent.id,
      userId: t.requesterUserId,
      until: Date.now() + FOLLOWUP_MS,
    });
  }

  /** Runs one turn to its single final reply. Resolves true when a reply was posted. */
  private async runTurn(dev: Device, turn: Turn): Promise<boolean> {
    const { chatId } = turn;
    // Live signals are sent in order, never block the turn and are safe to lose. They follow
    // the 👀 reaction, so people see "seen" before anything else.
    let signals: Promise<void> = Promise.resolve();
    const act = (body: Omit<ActivityBody, "type">) => {
      const full: ActivityBody = { type: "activity", ...body, turn_id: turn.id };
      if (turn.replyTo) full.reply_to = turn.replyTo;
      if (turn.requesterUserId) full.requester = turn.requesterUserId.slice(0, 64);
      signals = signals
        .then(() => turn.eyes)
        .then(() => dev.engine.sendActivity(chatId, full))
        .catch(() => {});
    };
    let running = false;
    return this.queue.enqueue(
      () => {
        running = true;
        // the device may have been rebuilt while the turn waited
        return this.executeTurn(this.devices.get(turn.agentId) ?? dev, turn, act, () => signals);
      },
      turn.priority,
      (ahead) => {
        if (!running && ahead > 0) act({ phase: "queued", ahead });
      },
      {
        agentId: turn.agentId,
        requester: turn.requesterUserId ?? "",
        signal: turn.abort.signal,
        // the 3 s gap between two replies in a chat delays the turn without holding a slot
        notBefore: () => (this.lastReplyAt.get(`${turn.agentId}|${turn.chatId}`) ?? 0) + MIN_GAP_MS,
      },
    );
  }

  private async executeTurn(
    dev: Device,
    turn: Turn,
    act: (body: Omit<ActivityBody, "type">) => void,
    pending: () => Promise<void>,
  ): Promise<boolean> {
    const { db, runtime } = this.opts;
    const { agent } = dev;
    const { chatId } = turn;
    const abort = turn.abort.signal;
    const queuedMs = Date.now() - turn.started;
    let firstTokenMs: number | null = null;
    let timedOut = false;
    let skipped = false;
    const onTool = (agentId: string, name: string) => {
      if (agentId === agent.id) act({ phase: "tool", tool: name.slice(0, 64) });
    };
    let outcome: "done" | "stopped" | "error" = "done";
    const voice = turn.voice;
    const speaker = voice
      ? new Speaker(voice.audio, voice.language, (c) => {
          if (!turn.requesterUserId) return;
          publish([turn.requesterUserId], {
            type: "voice.chunk",
            chat_id: chatId,
            source_id: voice.sourceId,
            seq: c.seq,
            text: c.text.slice(0, 1000),
            wav_b64: Buffer.from(c.wav).toString("base64"),
          });
        })
      : null;
    let spoke = false;
    let text: string;
    let read = 0;
    let steps: TraceStep[] = [];
    const meta: TextMeta = { local: true, turn_id: turn.id, trigger: turn.trigger };
    const model = runtime.modelName?.();
    if (model) meta.model = model.slice(0, 80);
    try {
      if (abort.aborted) throw abortError();
      const [member] = await db.query(
        "select 1 from sa.chat_members where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null",
        [chatId, agent.id],
      );
      if (!member) {
        this.turns.delete(turn.id);
        await turn.eyes;
        await this.react(dev, turn, "👀", "remove");
        skipped = true;
        act({ phase: "done" });
        await pending();
        await this.record(turn, dev, "skipped", { queuedMs, firstTokenMs, doneMs: null, tools: 0 });
        return false;
      }
      act({ phase: "thinking" });
      this.toolLog.on("tool", onTool);
      if (abort.aborted) throw abortError();
      await runtime.ensureStarted(agent);
      if (abort.aborted) throw abortError();
      const context = await this.context(dev, turn, act);
      read = context.read;
      act({ phase: "reading", count: read });
      const ctx: TurnContext = {
        turnId: turn.id,
        agentId: agent.id,
        agentName: agent.name,
        chatId,
        replyTo: turn.replyTo ?? null,
        triggerMessageId: turn.messageId ?? null,
        requesterUserId: turn.requesterUserId ?? null,
        trigger: turn.trigger,
        prompt: turn.text,
        noTaught: turn.noTaught ?? false,
      };
      beginTurn(ctx, log);
      this.toolLog.begin(agent.id, chatId, {
        turnId: turn.id,
        ...(turn.requesterUserId ? { requesterUserId: turn.requesterUserId } : {}),
      });
      setForceFirstTool(agent.id, turn.force);
      let reply: Awaited<ReturnType<AgentRuntime["chat"]>>;
      try {
        let draft = "";
        let shown = "";
        let lastSent = 0;
        // A before-reply hook may hold the answer, so live drafts must not carry model text.
        const guarded = hasBeforeReplyHooks();
        const flush = () => {
          if (draft === shown || abort.aborted) return;
          shown = draft;
          lastSent = Date.now();
          act(guarded ? { phase: "writing" } : { phase: "writing", draft });
        };
        const streamed = runtime.chatStream?.bind(runtime);
        reply = streamed
          ? await streamed(
              agent,
              chatId,
              context.messages,
              (t) => {
                if (abort.aborted) return;
                firstTokenMs ??= Date.now() - turn.started;
                draft = (draft + t).slice(0, DRAFT_MAX);
                if (speaker && !guarded) {
                  speaker.push(t);
                  spoke = true;
                }
                if (Date.now() - lastSent >= WRITING_GAP_MS) flush();
              },
              { signal: abort },
            )
          : await runtime.chat(agent, chatId, context.messages, { signal: abort });
        // Past this point the turn can no longer be stopped; a result that arrives after Stop
        // (the non-streaming fallback cannot be interrupted) is discarded.
        this.turns.delete(turn.id);
        if (abort.aborted) throw abortError();
        flush();
      } finally {
        steps = this.toolLog.end(agent.id);
      }
      const trace: TraceStep[] = [];
      if (reply.reasoning?.trim())
        trace.push({ kind: "thinking", text: reply.reasoning.slice(0, 4000) });
      trace.push(...context.imageSteps, ...steps);
      meta.trace = trace.slice(0, 30);
      text = reply.content.slice(0, 8000) || "(no answer)";
      const out = await runBeforeReply(ctx, { text, meta }, log);
      text = out.text;
      Object.assign(meta, out.meta);
      if (out.failed) outcome = "error";
      else if (speaker && !spoke) speaker.push(text);
    } catch (e) {
      const name = (e as Error).name;
      if (abort.aborted) {
        outcome = "stopped";
        meta.stopped_by = (turn.stoppedBy ?? turn.requesterName ?? "the requester").slice(0, 80);
        text = `Stopped by ${meta.stopped_by}.`;
        log("agent turn stopped", { agent: agent.id, turn: turn.id });
      } else if (name === "TimeoutError") {
        // Bug 2: the time limit is not an outage, so the agent status stays as it was.
        outcome = "error";
        timedOut = true;
        text = LIMIT;
        log("agent turn timed out", { agent: agent.id, turn: turn.id });
      } else {
        outcome = "error";
        text = DOWN;
        log("agent turn failed", {
          agent: agent.id,
          error: name,
          status: (e as { status?: unknown }).status,
        });
        await db.query("update sa.agents set status = 'error' where id = $1", [agent.id]);
      }
    } finally {
      this.turns.delete(turn.id);
      this.toolLog.off("tool", onTool);
      endTurn(agent.id, log);
    }
    if (outcome !== "done") speaker?.abort();
    meta.tools = steps.flatMap((s) => (s.kind === "tool" ? [s.name] : [])).slice(0, 20);
    meta.read = read;
    meta.ms = Date.now() - turn.started;
    await pending();
    this.lastReplyAt.set(`${agent.id}|${chatId}`, Date.now());
    this.claimThread(dev, turn);
    let sent = true;
    let latency: VoiceLatency | undefined;
    if (voice && speaker && outcome === "done") {
      const spoken = await speaker.finish();
      if (spoken.wav) {
        try {
          meta.audio_id = await dev.engine.sendFile(
            chatId,
            { name: `reply-${Date.now()}.wav`, mime: "audio/wav", bytes: spoken.wav },
            {
              ...(turn.replyTo ? { replyTo: turn.replyTo } : {}),
              voice: { duration_ms: Math.max(1, spoken.durationMs) },
            },
          );
        } catch (e) {
          log("agent voice send failed", { agent: agent.id, error: (e as Error).message });
        }
      }
      latency = { stt_ms: voice.sttMs, total_ms: 0 };
      if (firstTokenMs !== null)
        latency.first_token_ms = Math.max(0, turn.started - voice.receivedAt + firstTokenMs);
      if (spoken.firstAudioAt !== null && meta.audio_id)
        latency.first_audio_ms = Math.max(0, spoken.firstAudioAt - voice.receivedAt);
      latency.total_ms = Math.max(voice.sttMs, Date.now() - voice.receivedAt);
      meta.latency = latency;
    }
    try {
      await dev.engine.sendText(
        chatId,
        text,
        meta,
        turn.replyTo ? { replyTo: turn.replyTo } : undefined,
      );
      log("agent replied", {
        agent: agent.id,
        chat: chatId,
        turn: turn.id,
        outcome,
        ms: meta.ms,
        size: text.length,
      });
      if (latency && turn.requesterUserId && voice) {
        publish([turn.requesterUserId], {
          type: "latency.sample",
          chat_id: chatId,
          source_id: voice.sourceId,
          latency,
        });
      }
    } catch (e) {
      sent = false;
      log("agent send failed", { agent: agent.id, error: (e as Error).message });
    }
    const final = sent ? outcome : "error";
    if (turn.messageId) {
      await turn.eyes;
      await this.react(dev, turn, "👀", "remove");
      await this.react(dev, turn, DONE_EMOJI[final], "add");
    }
    act({ phase: final });
    await pending();
    const toolCount = steps.filter((s) => s.kind === "tool").length;
    const recorded: TurnOutcome = final === "error" && timedOut && sent ? "timeout" : final;
    await this.record(turn, dev, skipped ? "skipped" : recorded, {
      queuedMs,
      firstTokenMs,
      doneMs: Date.now() - turn.started,
      tools: toolCount,
    });
    return sent;
  }

  /** Stores the turn's ids and timings (never text) and logs one line. */
  private async record(
    turn: Turn,
    dev: Device,
    outcome: TurnOutcome,
    t: { queuedMs: number; firstTokenMs: number | null; doneMs: number | null; tools: number },
  ): Promise<void> {
    const eyesMs = turn.eyesMs ?? null;
    log("turn", {
      turn_id: turn.id,
      agent: dev.agent.id,
      trigger: turn.trigger,
      outcome,
      eyes_ms: eyesMs,
      first_token_ms: t.firstTokenMs,
      done_ms: t.doneMs,
      tools: t.tools,
    });
    try {
      await recordTurn(this.opts.db, {
        turnId: turn.id,
        agentId: dev.agent.id,
        chatId: turn.chatId,
        threadRoot: turn.replyTo ?? null,
        requesterUserId: turn.requesterUserId ?? null,
        trigger: turn.trigger,
        queuedMs: t.queuedMs,
        eyesMs,
        firstTokenMs: t.firstTokenMs,
        doneMs: t.doneMs,
        tools: t.tools,
        outcome,
      });
    } catch (e) {
      log("turn metrics failed", { agent: dev.agent.id, error: (e as Error).message });
    }
  }

  /** The chat context: the last messages up to the trigger, plus the thread being answered. */
  private async context(
    dev: Device,
    turn: Turn,
    act: (body: Omit<ActivityBody, "type">) => void,
  ): Promise<{ messages: ChatMessage[]; read: number; imageSteps: TraceStep[] }> {
    const { db } = this.opts;
    const describe = this.opts.describe ?? describeImage;
    const { agent } = dev;
    const { chatId } = turn;
    const [chat] = await db.query<{ title: string }>("select title from sa.chats where id = $1", [
      chatId,
    ]);
    const select = `select p.id, coalesce(u.display_name, a.name, p.sender_device) as name, p.body
       from sa.messages_plain p
       left join sa.devices d on d.id = p.sender_device
       left join sa.users u on d.owner_type = 'user' and u.id = d.owner_id
       left join sa.agents a on d.owner_type = 'agent' and a.id = d.owner_id
       where p.device_id = $1 and p.chat_id = $2 and p.body->>'type' in ('text', 'file')`;
    type Row = { id: string; name: string | null; body: Record<string, unknown> };
    // The context ends at the trigger message, even when the turn waited behind another one.
    const upTo = turn.seq !== undefined ? `and p.seq <= ${Number(turn.seq)}` : "";
    const recent = await db.query<Row>(
      `${select} ${upTo} order by p.seq desc limit ${CONTEXT_MESSAGES}`,
      [dev.deviceId, chatId],
    );
    // Newest first; with a trigger message, index 0 is that message.
    const imageSteps: TraceStep[] = [];
    const skip = turn.messageId ? 1 : 0;
    for (const r of recent.slice(skip, skip + IMAGE_WINDOW)) {
      const b = r.body;
      if (b.type !== "file" || !isImage(b.mime) || typeof b.description === "string") continue;
      const fname = String(b.name);
      act({ phase: "tool", tool: "describe_image" });
      const t0 = Date.now();
      let result: string;
      try {
        const bytes = await this.fileBytes(dev, b as never);
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
    const line = (r: Row) => {
      const b = r.body;
      if (b.type !== "file") return `${r.name}: ${b.text}`;
      if (!isImage(b.mime)) return `${r.name}: [file ${b.name}, ${formatSize(Number(b.size))}]`;
      return typeof b.description === "string"
        ? `${r.name}: [image ${b.name}] ${b.description}`
        : `${r.name}: [image ${b.name}, could not be read]`;
    };
    // In a thread, the root and its latest replies are context too; recent lines that belong to
    // the thread are marked, and thread messages older than the window are added once.
    let thread: Row[] = [];
    let opening = "";
    if (turn.replyTo) {
      thread = await db.query<Row>(
        `${select} ${upTo} and (p.id = $3 or p.body->>'reply_to' = $3)
         order by (p.id = $3) desc, p.seq desc limit ${THREAD_REPLIES + 1}`,
        [dev.deviceId, chatId, turn.replyTo],
      );
      const root = thread.find((r) => r.id === turn.replyTo);
      const rootText = String(root?.body.text ?? root?.body.name ?? "").slice(0, 300);
      opening = root
        ? `You are replying in a thread that starts with ${root.name}: "${rootText}". Lines marked (thread) belong to it.`
        : "You are replying in a thread. Lines marked (thread) belong to it.";
    }
    const inThread = new Set(thread.map((r) => r.id));
    const inRecent = new Set(recent.map((r) => r.id));
    const label = (r: Row) => (inThread.has(r.id) ? `(thread) ${line(r)}` : line(r));
    // Root first, then the replies oldest first.
    const ordered = [
      ...thread.filter((r) => r.id === turn.replyTo),
      ...thread.filter((r) => r.id !== turn.replyTo).reverse(),
    ];
    const earlier = ordered.filter((r) => !inRecent.has(r.id)).map(label);
    const history = [...earlier, ...recent.reverse().map(label)];
    const system = [
      `You are ${agent.name} in the chat "${chat?.title ?? ""}" (chat_id ${chatId}).`,
      ...(opening ? [opening] : []),
      "Messages you can see, oldest first:",
      ...history,
    ];
    return {
      messages: [
        { role: "system", content: system.join("\n") },
        { role: "user", content: turn.text },
      ],
      read: history.length,
      imageSteps,
    };
  }
}

const mentions = (name: string, text: string) =>
  new RegExp(`@${escapeRe(name)}(?![\\p{L}\\p{N}_])`, "iu").test(text);
