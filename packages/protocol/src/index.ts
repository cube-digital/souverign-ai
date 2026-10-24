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
  phase: z.enum(["thinking", "tool", "writing", "done", "error"]),
  tool: z.string().max(64).optional(),
  draft: z.string().max(8000).optional(),
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

/** The plaintext inside a "msg" envelope. */
export const MessageBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(8000),
    meta: z
      .object({
        tools: z.array(z.string().max(64)).max(20).optional(),
        ms: z.number().int().nonnegative().optional(),
        trace: z.array(TraceStep).max(30).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("file"),
    blob_id: Id,
    name: z.string().min(1).max(255),
    mime: z.string().max(127),
    size: z.number().int().nonnegative().max(MAX_BLOB_BYTES),
    key: B64,
    nonce: B64,
  }),
  z.object({ type: z.literal("system"), text: z.string().min(1).max(500) }),
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
export const ChatMember = z.object({
  member_type: z.enum(["user", "agent"]),
  member_id: z.string(),
  display_name: z.string(),
  owner_display_name: z.string().optional(),
  role: z.enum(["owner", "member"]),
  devices: z.array(DevicePublic),
});
export type ChatMember = z.infer<typeof ChatMember>;
export const Chat = z.object({
  id: Id,
  title: z.string(),
  kind: z.enum(["dm", "group", "room"]),
  created_by: z.string(),
  members: z.array(ChatMember),
});
export type Chat = z.infer<typeof Chat>;
export const CreateChatRequest = z.object({
  title: z.string().trim().min(1).max(80),
  member_user_ids: z.array(z.string()).max(16),
});
export const AddMemberRequest = z.object({ user_id: z.string().min(1) });

export const AgentTemplate = z.enum(["general", "devops", "qa"]);
export type AgentTemplate = z.infer<typeof AgentTemplate>;
export const AgentStatus = z.enum(["stopped", "starting", "running", "error"]);
export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  template: AgentTemplate,
  soul: z.string(),
  owner_user_id: z.string(),
  device_id: Id,
  status: AgentStatus,
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
export const ApiError = z.object({
  error: z.string(),
  missing_devices: z.array(z.string()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
