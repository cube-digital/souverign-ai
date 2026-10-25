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
  "retry",
  "answer",
]);
export type TurnTrigger = z.infer<typeof TurnTrigger>;

export const SharePolicy = z.enum(["always", "ask", "never"]);
export type SharePolicy = z.infer<typeof SharePolicy>;
export const MemoryKind = z.enum(["conversation", "knowledge", "correction", "meeting"]);
/** "meeting" is ingested by the voice plan */
export const SourceType = z.enum(["message", "file", "doc", "note", "correction", "meeting"]);
export const Citation = z.object({
  n: z.number().int().min(1).max(8),
  space: z.enum(["chat", "agent"]),
  kind: MemoryKind,
  source_type: SourceType,
  source_id: z.string().max(80),
  title: z.string().max(200).nullable(),
  /** epoch ms (bridge receipt time for chat sources) */
  ts: z.number(),
  /** chat sources and notes/corrections: the chat */
  chat_id: Id.optional(),
  /** chat sources: the message to open */
  message_id: Id.optional(),
  /** agent sources: the agent and the knowledge item to open */
  agent_id: z.string().max(40).optional(),
  item_id: z.string().max(40).optional(),
  page: z.number().int().min(1).optional(),
  taught_by: z.string().max(80).optional(),
  /** the reply text references [n] */
  cited: z.boolean(),
});
export type Citation = z.infer<typeof Citation>;
export const ApprovalStatus = z.enum([
  "pending",
  "approved",
  "executed",
  "failed",
  "denied",
  "expired",
  "canceled",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;
/** Open registry: any registered tool name (bridge `registerGatedTool`); later plans add their own. */
export const GatedTool = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
export type GatedTool = z.infer<typeof GatedTool>;
export const ApprovalField = z.object({
  key: z.string().max(40),
  label: z.string().max(40),
  value: z.string().max(8000),
  editable: z.boolean(),
  multiline: z.boolean(),
});
export const ApprovalPreview = z.object({
  title: z.string().max(200),
  target: z.string().max(200),
  fields: z.array(ApprovalField).max(8),
  sources: z.array(Citation).max(8).optional(),
  leaves_chat: z.boolean(),
});
export type ApprovalPreview = z.infer<typeof ApprovalPreview>;
export const Approval = z.object({
  id: z.string().max(40),
  agent_id: z.string(),
  agent_name: z.string(),
  chat_id: Id,
  chat_title: z.string(),
  reply_to: Id.nullable(),
  kind: z.enum(["tool", "share"]),
  tool: GatedTool,
  args: z.record(z.string(), z.unknown()),
  preview: ApprovalPreview,
  status: ApprovalStatus,
  requester_user_id: z.string().nullable(),
  approver_user_id: z.string(),
  approver_name: z.string(),
  decided_by: z.string().nullable(),
  decided_at: z.number().int().nullable(),
  created_at: z.number().int(),
  expires_at: z.number().int(),
  result: z.string().max(500).nullable(),
  auto: z.boolean(),
  /** the card may offer "Always approve this tool" */
  always_allowed: z.boolean(),
});
export type Approval = z.infer<typeof Approval>;
export const ApprovalPublic = z.object({
  id: z.string().max(40),
  chat_id: Id,
  agent_name: z.string(),
  tool: GatedTool,
  status: ApprovalStatus,
  approver_name: z.string(),
  /** lets the requester's client offer Cancel */
  requester_user_id: z.string().nullable(),
});
export type ApprovalPublic = z.infer<typeof ApprovalPublic>;
export const ApprovalDecision = z.object({
  decision: z.enum(["approve", "deny"]),
  args: z.record(z.string(), z.string().max(8000)).optional(),
  always: z.boolean().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
export const ApprovalGrant = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  tool: GatedTool,
  created_at: z.number().int(),
});
export type ApprovalGrant = z.infer<typeof ApprovalGrant>;
export const KnowledgeItem = z.object({
  id: z.string().max(40),
  agent_id: z.string(),
  kind: z.enum(["document", "note", "correction"]),
  title: z.string(),
  mime: z.string().nullable(),
  size: z.number().int().nullable(),
  parts: z.number().int().min(0),
  truncated: z.boolean(),
  tags: z.array(z.string()),
  origin_chat_id: Id.nullable(),
  origin_chat_title: z.string().nullable(),
  taught_by_user_id: z.string().nullable(),
  taught_by_name: z.string().nullable(),
  created_at: z.number().int(),
  /** first 200 chars of the text */
  preview: z.string().max(200),
});
export type KnowledgeItem = z.infer<typeof KnowledgeItem>;
export const KnowledgeItemDetail = KnowledgeItem.extend({
  segments: z.array(z.object({ label: z.string().nullable(), text: z.string() })),
});
export type KnowledgeItemDetail = z.infer<typeof KnowledgeItemDetail>;
export const Lesson = z.object({
  id: z.string().max(40),
  agent_id: z.string(),
  text: z.string().min(1).max(500),
  taught_by_user_id: z.string().nullable(),
  taught_by_name: z.string().nullable(),
  created_at: z.number().int(),
});
export type Lesson = z.infer<typeof Lesson>;
export const CreateLessonRequest = z.object({ text: z.string().trim().min(1).max(500) });
export const CorrectionRequest = z.object({
  chat_id: Id,
  message_id: Id,
  text: z.string().trim().min(1).max(1000),
});
export const SharingRequest = z.object({ share_private_in_chats: SharePolicy });
export const Note = z.object({
  id: z.string().max(40),
  agent_id: z.string(),
  agent_name: z.string(),
  chat_id: Id,
  title: z.string(),
  body_md: z.string(),
  created_at: z.number().int(),
});
export type Note = z.infer<typeof Note>;
export const Question = z.object({
  id: z.string().max(40),
  agent_id: z.string(),
  agent_name: z.string(),
  chat_id: Id,
  reply_to: Id.nullable(),
  requester_user_id: z.string(),
  requester_name: z.string(),
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(80)).max(4),
  status: z.enum(["open", "answered", "expired", "canceled"]),
  answer: z.string().max(1000).nullable(),
  created_at: z.number().int(),
  expires_at: z.number().int(),
});
export type Question = z.infer<typeof Question>;
export const AnswerRequest = z
  .object({
    option: z.number().int().min(0).max(3).optional(),
    text: z.string().trim().min(1).max(1000).optional(),
  })
  .refine(
    (a) => (a.option === undefined) !== (a.text === undefined),
    "exactly one of option or text",
  );
// ---- Voice and calls ----
export const MAX_VOICE_MS = 60_000;
export const VoiceInfo = z.object({
  duration_ms: z.number().int().positive().max(MAX_VOICE_MS),
});
export type VoiceInfo = z.infer<typeof VoiceInfo>;

export const VoiceLatency = z.object({
  stt_ms: z.number().int().nonnegative(),
  first_token_ms: z.number().int().nonnegative().optional(),
  first_audio_ms: z.number().int().nonnegative().optional(),
  total_ms: z.number().int().nonnegative(),
});
export type VoiceLatency = z.infer<typeof VoiceLatency>;

export const ActionItem = z.object({
  owner: z.string().min(1).max(80),
  text: z.string().min(1).max(300),
  due: z.string().min(1).max(40).optional(),
});
export type ActionItem = z.infer<typeof ActionItem>;

/** Call start/end marker carried in a text message (inside the ciphertext). */
export const CallMeta = z.object({
  call_id: Id,
  op: z.enum(["started", "ended"]),
  /** LiveKit media key, base64url of 32 random bytes; never sent to the bridge DB */
  media_key: B64.optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});
export type CallMeta = z.infer<typeof CallMeta>;

export const MeetingMeta = z.object({
  call_id: Id,
  action_items: z.array(ActionItem).max(30),
});

/** Scribe's DM about call notes: review them (pending) or publish them again (not_published). */
export const CallNotesRef = z.object({
  call_id: Id,
  notes_id: Id,
  state: z.enum(["pending", "not_published"]),
});

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
  /** memory sources this answer read; `cited` when the text references [n] */
  citations: z.array(Citation).max(8).optional(),
  /** approvals this turn created; the approver's card renders under the reply */
  approvals: z.array(z.string().max(40)).max(4).optional(),
  /** a status stamp for one approval */
  approval: z.object({ id: z.string().max(40), status: ApprovalStatus }).optional(),
  /** this message is a private-preview notice; the held answer's approval id */
  held: z.string().max(40).optional(),
  /** display name of the person who approved this post */
  approved_by: z.string().max(80).optional(),
  /** an ask_user question card */
  question: z
    .object({ id: z.string().max(40), options: z.array(z.string().max(80)).max(4) })
    .optional(),
  /** voice reply timings, measured by the bridge */
  latency: VoiceLatency.optional(),
  /** the voice file message that speaks this text */
  audio_id: Id.optional(),
  /** this text is the transcript of that voice message */
  transcript_of: Id.optional(),
  call: CallMeta.optional(),
  meeting: MeetingMeta.optional(),
  call_notes: CallNotesRef.optional(),
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
    voice: VoiceInfo.optional(),
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
  /** the newest epoch the bridge handed out; a key for a later epoch is not trusted (0: legacy, unbounded) */
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
  share_private_in_chats: SharePolicy.optional(),
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

export const AuthProviders = z.object({
  pin: z.boolean(),
  oidc: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,32}$/), label: z.string().max(40) })),
});
export type AuthProviders = z.infer<typeof AuthProviders>;
export const OidcExchangeRequest = z.object({ code: z.string().min(20).max(128) });
export type OidcExchangeRequest = z.infer<typeof OidcExchangeRequest>;

export const ConsentDecision = z.enum(["pending", "accepted", "declined"]);
export type ConsentDecision = z.infer<typeof ConsentDecision>;
export const NotetakerStatus = z.enum(["active", "stopped", "finished", "failed"]);
export type NotetakerStatus = z.infer<typeof NotetakerStatus>;
export const WorkerState = z.enum(["starting", "joined", "left", "error", "fake"]);
export type WorkerState = z.infer<typeof WorkerState>;

export const CallParticipant = z.object({
  user_id: z.string(),
  name: z.string(),
  in_call: z.boolean(),
  consent: ConsentDecision,
});
export type CallParticipant = z.infer<typeof CallParticipant>;

export const CallNotetaker = z.object({
  id: Id,
  agent_id: z.string(),
  agent_name: z.string(),
  invited_by: z.string(),
  invited_by_name: z.string(),
  invited_at: z.number().int(),
  status: NotetakerStatus,
  worker: WorkerState,
  stopped_by_name: z.string().nullable(),
});
export type CallNotetaker = z.infer<typeof CallNotetaker>;

export const CallInfo = z.object({
  id: Id,
  chat_id: Id,
  room: z.string(),
  started_by: z.string(),
  started_at: z.number().int(),
  ended_at: z.number().int().nullable(),
  anchor_message_id: Id.nullable(),
  e2ee: z.boolean(),
  participants: z.array(CallParticipant),
  notetaker: CallNotetaker.nullable(),
});
export type CallInfo = z.infer<typeof CallInfo>;

export const CallToken = z.object({
  available: z.boolean(),
  url: z.string(),
  token: z.string(),
  identity: z.string(),
});
export type CallToken = z.infer<typeof CallToken>;

export const CallSegment = z.object({
  id: z.number().int(),
  speaker_user_id: z.string(),
  speaker_name: z.string(),
  /** ms since the call started */
  t_ms: z.number().int().nonnegative(),
  text: z.string(),
});
export type CallSegment = z.infer<typeof CallSegment>;

export const CallNotesStatus = z.enum(["draft", "pending_approval", "published", "not_published"]);
export const CallNotes = z.object({
  id: Id,
  version: z.number().int().min(1),
  final: z.boolean(),
  body_md: z.string(),
  action_items: z.array(ActionItem),
  status: CallNotesStatus,
  approval_id: z.string().nullable(),
});
export type CallNotes = z.infer<typeof CallNotes>;

export const AnchorRequest = z.object({ message_id: Id });
/** LiveKit media key: base64url (no padding) of 32 random bytes. */
export const MediaKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const NotetakerInvite = z.object({ media_key: MediaKey.optional() });
export const ConsentRequest = z.object({ decision: z.enum(["accepted", "declined"]) });

/** worker → bridge (internal) */
export const SegmentIn = z.object({
  speaker: z.string().regex(/^user:[A-Za-z0-9_-]{1,64}$/),
  /** epoch ms */
  t0_ms: z.number().int().nonnegative(),
  t1_ms: z.number().int().nonnegative(),
  text: z.string().min(1).max(4000),
  lang: z.string().max(8).optional(),
});
export type SegmentIn = z.infer<typeof SegmentIn>;
export const WorkerReport = z.object({
  state: z.enum(["joined", "left", "error"]),
  detail: z.string().max(200).optional(),
});
export const WorkerStateResponse = z.object({
  status: NotetakerStatus,
  /** LiveKit identities (`user:<id>`) that may be subscribed right now */
  consented: z.array(z.string()),
});
export type WorkerStateResponse = z.infer<typeof WorkerStateResponse>;

/** SSE events added by this plan (event name = `type`, data = the JSON object). */
export const CallEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("call.updated"), call: CallInfo }),
  z.object({ type: z.literal("call.segment"), call_id: Id, segment: CallSegment }),
  z.object({
    type: z.literal("call.notes"),
    call_id: Id,
    version: z.number().int().min(1),
    final: z.boolean(),
  }),
  z.object({
    type: z.literal("call.notes_published"),
    call_id: Id,
    chat_id: Id,
    message_id: Id,
    title: z.string().max(200),
  }),
]);
export type CallEvent = z.infer<typeof CallEvent>;
export const VoiceEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("voice.chunk"),
    chat_id: Id,
    /** the user's voice message this audio answers */
    source_id: Id,
    seq: z.number().int().nonnegative(),
    text: z.string().max(1000),
    wav_b64: z.string(),
  }),
  z.object({
    type: z.literal("latency.sample"),
    chat_id: Id,
    source_id: Id,
    latency: VoiceLatency,
  }),
]);
export type VoiceEvent = z.infer<typeof VoiceEvent>;

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), user_id: z.string() }),
  z.object({ type: z.literal("approval"), approval: Approval }),
  z.object({ type: z.literal("approval_public"), approval: ApprovalPublic }),
  z.object({ type: z.literal("question"), question: Question }),
  ...CallEvent.options,
  ...VoiceEvent.options,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
