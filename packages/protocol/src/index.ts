import { z } from "zod";

/** base64url without padding */
export const B64 = z.string().regex(/^[A-Za-z0-9_-]*$/);
export const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const MAX_BLOB_BYTES = 10 * 1024 * 1024;
export const MAX_CIPHERTEXT_CHARS = 350_000;

/** What travels through the relay. Everything private is inside `ciphertext`. */
export const Envelope = z
  .object({
    v: z.literal(1),
    id: Id,
    chat_id: Id,
    sender_device: Id,
    /** only for kind "key": the device the sealed chat key is for */
    to_device: Id.optional(),
    epoch: z.number().int().min(1),
    kind: z.enum(["msg", "key", "status"]),
    nonce: B64,
    ciphertext: B64.max(MAX_CIPHERTEXT_CHARS),
    ts: z.number().int().nonnegative(),
  })
  .refine((e) => (e.kind === "key") === (e.to_device !== undefined), {
    message: "to_device is required for key envelopes and forbidden otherwise",
  });
export type Envelope = z.infer<typeof Envelope>;

export const ClientOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("hello"), device_id: Id, ticket: z.string().min(10).max(512) }),
  z.object({ op: z.literal("send"), env: Envelope }),
  z.object({ op: z.literal("sync"), chat_id: Id, since: z.number().int().nonnegative() }),
  z.object({ op: z.literal("blob_put"), id: Id, chat_id: Id, data: B64 }),
  z.object({ op: z.literal("blob_get"), id: Id }),
  z.object({ op: z.literal("signal"), env: Envelope }),
]);
export type ClientOp = z.infer<typeof ClientOp>;

export const ErrorCode = z.enum([
  "bad_request",
  "no_hello",
  "not_member",
  "too_large",
  "not_found",
  "bad_ticket",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const TICKET_TTL_MS = 12 * 60 * 60 * 1000;
export const RelayTicketRequest = z.object({ device_id: Id });
export const RelayTicketResponse = z.object({ ticket: z.string(), expires_at: z.number().int() });

export const RelayOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("ready"), device_id: Id }),
  z.object({ op: z.literal("deliver"), seq: z.number().int().positive(), env: Envelope }),
  z.object({ op: z.literal("ack"), id: Id, seq: z.number().int().positive() }),
  z.object({
    op: z.literal("synced"),
    chat_id: Id,
    seq: z.number().int().nonnegative(),
    more: z.boolean(),
  }),
  z.object({ op: z.literal("signal"), env: Envelope }),
  z.object({ op: z.literal("blob_ok"), id: Id }),
  z.object({ op: z.literal("blob"), id: Id, data: B64 }),
  z.object({
    op: z.literal("error"),
    code: ErrorCode,
    message: z.string(),
    ref: z.string().optional(),
  }),
]);
export type RelayOp = z.infer<typeof RelayOp>;

/** POST /relay/admin/members, bridge only (Authorization: Bearer RELAY_ADMIN_TOKEN) */
export const RelayMemberChange = z.object({
  chat_id: Id,
  device_id: Id,
  op: z.enum(["add", "remove"]),
  history_until_seq: z.number().int().nonnegative().optional(),
});
export type RelayMemberChange = z.infer<typeof RelayMemberChange>;

/** GET /relay/debug/recent: what the relay holds, for the "What the relay sees" panel */
export const RelayRecentRow = z.object({
  seq: z.number().int(),
  ts: z.number().int(),
  kind: z.enum(["msg", "key"]),
  chat_id: Id,
  sender_device: Id,
  to_device: Id.nullable(),
  size: z.number().int(),
  ciphertext_prefix: z.string(),
});
export type RelayRecentRow = z.infer<typeof RelayRecentRow>;

export const ActivityBody = z.object({
  type: z.literal("activity"),
  phase: z.enum(["queued", "thinking", "reading", "tool", "writing", "done", "error", "stopped"]),
  tool: z.string().max(64).optional(),
  draft: z.string().max(8000).optional(),
  turn_id: Id.optional(),
  /** thread root the turn answers in; absent for top-level turns */
  reply_to: Id.optional(),
  /** user id of the person who triggered the turn; only they may stop it */
  requester: z.string().max(64).optional(),
  /** messages read, for phase "reading" */
  count: z.number().int().nonnegative().optional(),
  /** turns ahead in the LLM queue, for phase "queued" */
  ahead: z.number().int().nonnegative().optional(),
});
export type ActivityBody = z.infer<typeof ActivityBody>;

/** One step of an agent's reasoning trace, carried inside the encrypted message. */
export const TraceStep = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thinking"), text: z.string().max(4000) }),
  z.object({
    kind: z.literal("tool"),
    name: z.string().max(64),
    args: z.string().max(500),
    result: z.string().max(1500),
    ms: z.number().int().nonnegative(),
  }),
]);
export type TraceStep = z.infer<typeof TraceStep>;

export const TurnTrigger = z.enum([
  "mention",
  "followup",
  "dm",
  "access",
  "alert",
  "catchup",
  "routine",
  "welcome",
  "intro",
]);
export type TurnTrigger = z.infer<typeof TurnTrigger>;

/** Receipts an agent attaches to its reply (inside the ciphertext). */
export const TextMeta = z.object({
  tools: z.array(z.string().max(64)).max(20).optional(),
  ms: z.number().int().nonnegative().optional(),
  trace: z.array(TraceStep).max(30).optional(),
  read: z.number().int().nonnegative().optional(),
  model: z.string().max(80).optional(),
  local: z.boolean().optional(),
  turn_id: Id.optional(),
  trigger: TurnTrigger.optional(),
  stopped_by: z.string().max(80).optional(),
  /** seeded demo history (D-12): no receipts */
  seeded: z.boolean().optional(),
  /** example prompts rendered as clickable chips (join intro) */
  chips: z.array(z.string().min(1).max(120)).max(3).optional(),
});
export type TextMeta = z.infer<typeof TextMeta>;

export const ReactionOp = z.enum(["add", "remove"]);

/** The plaintext inside a "msg" envelope. */
export const MessageBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(8000),
    /** id of the thread root this message replies to */
    reply_to: Id.optional(),
    meta: TextMeta.optional(),
  }),
  z.object({
    type: z.literal("file"),
    blob_id: Id,
    name: z.string().min(1).max(255),
    mime: z.string().max(127),
    size: z.number().int().nonnegative().max(MAX_BLOB_BYTES),
    key: B64,
    nonce: B64,
    reply_to: Id.optional(),
  }),
  z.object({ type: z.literal("system"), text: z.string().min(1).max(500) }),
  z.object({
    type: z.literal("reaction"),
    target: Id,
    emoji: z.string().min(1).max(16),
    op: ReactionOp,
  }),
]);
export type MessageBody = z.infer<typeof MessageBody>;

// Bridge API (/api)
export const UserSummary = z.object({ id: z.string(), display_name: z.string() });
export type UserSummary = z.infer<typeof UserSummary>;
export const LoginRequest = z.object({
  user_id: z.string().min(1),
  pin: z.string().regex(/^\d{4,8}$/),
});
export const LoginResponse = z.object({ token: z.string(), user: UserSummary });
export type LoginResponse = z.infer<typeof LoginResponse>;
export const DeviceRegistration = z.object({ device_id: Id, public_key: B64 });
export const DevicePublic = z.object({ device_id: Id, public_key: B64 });
export type DevicePublic = z.infer<typeof DevicePublic>;
export const DirectoryEntry = UserSummary.extend({ devices: z.array(DevicePublic) });
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;
export const AgentStatus = z.enum(["stopped", "starting", "running", "error"]);
export const AgentScope = z.enum(["personal", "workspace"]);
export type AgentScope = z.infer<typeof AgentScope>;
export const ChatMember = z.object({
  member_type: z.enum(["user", "agent"]),
  member_id: z.string(),
  display_name: z.string(),
  owner_display_name: z.string().optional(),
  role: z.enum(["owner", "member"]),
  devices: z.array(DevicePublic),
  agent_scope: AgentScope.optional(),
  /** a bridge-hosted demo colleague */
  seed: z.boolean().optional(),
  /** agents only */
  status: AgentStatus.optional(),
  /** epoch ms of the current membership; the member reads from here on */
  joined_at: z.number().int().optional(),
});
export type ChatMember = z.infer<typeof ChatMember>;
export const Chat = z.object({
  id: Id,
  title: z.string(),
  kind: z.enum(["dm", "group", "room"]),
  created_by: z.string(),
  members: z.array(ChatMember),
  topic: z.string().max(200).optional(),
  seed_key: z.string().max(40).optional(),
  /** the newest epoch the bridge handed out; a key for a later epoch is not trusted */
  key_epoch: z.number().int().nonnegative().optional(),
});
export type Chat = z.infer<typeof Chat>;
export const CreateChatRequest = z.object({
  title: z.string().trim().min(1).max(80),
  member_user_ids: z.array(z.string()).max(16),
});
export const AddMemberRequest = z.object({ user_id: z.string().min(1) });

export const AgentTemplate = z.enum([
  "general",
  "devops",
  "qa",
  "ops",
  "dev",
  "tech",
  "sales",
  "scribe",
]);
export type AgentTemplate = z.infer<typeof AgentTemplate>;
export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  template: AgentTemplate,
  soul: z.string(),
  owner_user_id: z.string().nullable(),
  device_id: Id,
  status: AgentStatus,
  scope: AgentScope,
  roster_id: z.string().nullable(),
});
export type Agent = z.infer<typeof Agent>;
export const CreateAgentRequest = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[\p{L}\p{N} _-]+$/u),
  template: AgentTemplate,
  soul: z.string().max(2000).default(""),
});
export const UpdateAgentRequest = z.object({ soul: z.string().max(2000) });
export const AddAgentRequest = z.object({ agent_id: z.string().min(1) });
export const EpochClaimRequest = z.object({ min: z.number().int().min(1).max(1_000_000) });
export const EpochClaimResponse = z.object({ epoch: z.number().int().min(1) });
export const HelloResponse = z.object({ catchup: z.boolean() });
/** time_zone is set by the server on GET and ignored on PUT */
export const Prefs = z.object({ pause_all: z.boolean(), time_zone: z.string().max(64).optional() });
export type Prefs = z.infer<typeof Prefs>;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const Weekdays = z.array(z.number().int().min(0).max(6)).min(1).max(7);
export const Routine = z.object({
  id: z.string(),
  kind: z.enum(["routine", "alert_watch"]),
  user_id: z.string().nullable(),
  agent_id: z.string(),
  chat_id: Id,
  days: Weekdays,
  time: z.string().regex(HHMM),
  prompt: z.string().min(1).max(500),
  paused: z.boolean(),
  last_run_at: z.number().int().nullable(),
});
export type Routine = z.infer<typeof Routine>;
export const CreateRoutineRequest = z.object({
  agent_id: z.string().min(1),
  chat_id: Id,
  days: Weekdays,
  time: z.string().regex(HHMM),
  prompt: z.string().trim().min(1).max(500),
});
export const UpdateRoutineRequest = z.object({ paused: z.boolean() });
export const ApiError = z.object({
  error: z.string(),
  missing_devices: z.array(z.string()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

// Roster and seed rooms are pure data, safe for every consumer (the web included).
export * from "./roster.js";
