import type { Approval, ApprovalGrant, ApprovalPreview, ApprovalStatus } from "@sa/protocol";
import type { Db } from "../db.js";

/** A joined `sa.approvals` row with timestamps as epoch ms. */
export type ApprovalRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  chat_id: string;
  chat_title: string;
  reply_to: string | null;
  turn_id: string | null;
  kind: "tool" | "share";
  tool: string;
  args: Record<string, unknown>;
  preview: ApprovalPreview;
  status: ApprovalStatus;
  requester_user_id: string | null;
  approver_user_id: string;
  approver_name: string;
  decided_by: string | null;
  auto: boolean;
  result: string | null;
  decided_ms: number | null;
  created_ms: number;
  expires_ms: number;
};

const ms = (col: string, as: string) => `(extract(epoch from a.${col}) * 1000)::float8 as ${as}`;
const COLS = `a.id, a.agent_id, ag.name as agent_name, a.chat_id, c.title as chat_title, a.reply_to,
  a.turn_id, a.kind, a.tool, a.args, a.preview, a.status, a.requester_user_id, a.approver_user_id,
  u.display_name as approver_name, a.decided_by, a.auto, a.result,
  ${ms("decided_at", "decided_ms")}, ${ms("created_at", "created_ms")}, ${ms("expires_at", "expires_ms")}`;
/** `src` is `sa.approvals` or the name of a CTE holding updated rows. */
const select = (src: string) =>
  `select ${COLS} from ${src} a
   join sa.agents ag on ag.id = a.agent_id
   join sa.chats c on c.id = a.chat_id
   join sa.users u on u.id = a.approver_user_id`;
/** Runs a data-modifying statement `returning *` and returns the joined new rows. */
const updated = (db: Db, sql: string, params: unknown[]) =>
  db.query<ApprovalRow>(`with x as (${sql} returning *) ${select("x")}`, params);

const member = (chatCol: string, userParam: string) =>
  `exists (select 1 from sa.chat_members m where m.chat_id = ${chatCol}
     and m.member_type = 'user' and m.member_id = ${userParam} and m.removed_at is null)`;

const json = (v: unknown) => (typeof v === "string" ? (JSON.parse(v) as unknown) : v);

/** `alwaysAllowed` comes from the tool registry, not the row. */
export function rowToApproval(r: ApprovalRow, alwaysAllowed: boolean): Approval {
  return {
    id: r.id,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    chat_id: r.chat_id,
    chat_title: r.chat_title,
    reply_to: r.reply_to,
    kind: r.kind,
    tool: r.tool,
    args: json(r.args) as Record<string, unknown>,
    preview: json(r.preview) as ApprovalPreview,
    status: r.status,
    requester_user_id: r.requester_user_id,
    approver_user_id: r.approver_user_id,
    approver_name: r.approver_name,
    decided_by: r.decided_by,
    decided_at: r.decided_ms === null ? null : Math.round(Number(r.decided_ms)),
    created_at: Math.round(Number(r.created_ms)),
    expires_at: Math.round(Number(r.expires_ms)),
    result: r.result,
    auto: r.auto,
    always_allowed: alwaysAllowed,
  };
}

export type NewApproval = {
  id: string;
  agentId: string;
  chatId: string;
  replyTo: string | null;
  turnId: string | null;
  kind: "tool" | "share";
  tool: string;
  args: Record<string, unknown>;
  preview: ApprovalPreview;
  requesterUserId: string | null;
  approverUserId: string;
  ttlMs: number;
};

const INSERT_COLS = `(id, agent_id, chat_id, reply_to, turn_id, kind, tool, args, preview,
  requester_user_id, approver_user_id, status, decided_by, decided_at, auto, expires_at)`;
const insertValues = (a: NewApproval) => [
  a.id,
  a.agentId,
  a.chatId,
  a.replyTo,
  a.turnId,
  a.kind,
  a.tool,
  JSON.stringify(a.args),
  JSON.stringify(a.preview),
  a.requesterUserId,
  a.approverUserId,
  a.ttlMs,
];

/** Live pending approvals and auto-approved runs in the last hour for `(agent, chat)`. */
export async function usage(
  db: Db,
  agentId: string,
  chatId: string,
): Promise<{ pending: number; autoLastHour: number }> {
  const [r] = await db.query<{ pending: number; auto: number }>(
    `select count(*) filter (where status = 'pending' and expires_at > now())::int as pending,
       count(*) filter (where auto and created_at > now() - interval '1 hour')::int as auto
     from sa.approvals where agent_id = $1 and chat_id = $2`,
    [agentId, chatId],
  );
  return { pending: r?.pending ?? 0, autoLastHour: r?.auto ?? 0 };
}

/** Inserts a pending approval; the caller holds the cap lock. */
export async function insertApproval(db: Db, a: NewApproval): Promise<ApprovalRow> {
  const [row] = await updated(
    db,
    `insert into sa.approvals ${INSERT_COLS}
     values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb, $10, $11, 'pending', null, null, false,
       now() + ($12::float8 * interval '1 millisecond'))`,
    insertValues(a),
  );
  if (!row) throw new Error("approval insert returned no row");
  return row;
}

/** A grant: the row starts approved and auto, decided by the approver. */
export async function insertAutoApproved(db: Db, a: NewApproval): Promise<ApprovalRow> {
  const [row] = await updated(
    db,
    `insert into sa.approvals ${INSERT_COLS}
     values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb, $10, $11, 'approved', $11, now(), true,
       now() + ($12::float8 * interval '1 millisecond'))`,
    insertValues(a),
  );
  if (!row) throw new Error("approval insert returned no row");
  return row;
}

export async function getApproval(db: Db, id: string): Promise<ApprovalRow | null> {
  const [row] = await db.query<ApprovalRow>(`${select("sa.approvals")} where a.id = $1`, [id]);
  return row ?? null;
}

export async function listForApprover(
  db: Db,
  userId: string,
  q: { status: "pending" | "all"; agentId?: string | undefined },
): Promise<ApprovalRow[]> {
  return db.query<ApprovalRow>(
    `${select("sa.approvals")}
     where a.approver_user_id = $1 and ($2::text is null or a.agent_id = $2)
       and ${member("a.chat_id", "$1")}
       and ($3 = 'all' or a.status = 'pending')
     order by a.created_at desc, a.id limit 100`,
    [userId, q.agentId ?? null, q.status],
  );
}

export async function listForRequester(
  db: Db,
  userId: string,
  q: { status: "pending" | "all"; agentId?: string | undefined },
): Promise<ApprovalRow[]> {
  return db.query<ApprovalRow>(
    `${select("sa.approvals")}
     where a.requester_user_id = $1 and ($2::text is null or a.agent_id = $2)
       and ${member("a.chat_id", "$1")}
       and ($3 = 'all' or a.status = 'pending')
     order by a.created_at desc, a.id limit 100`,
    [userId, q.agentId ?? null, q.status],
  );
}

/**
 * First decision wins: only a pending, unexpired row of this approver changes, and only while
 * the approver is still an active member of its chat. `preview` replaces the stored one (edits).
 */
export async function claimDecision(
  db: Db,
  id: string,
  userId: string,
  status: "approved" | "denied",
  args: Record<string, unknown>,
  preview?: ApprovalPreview,
): Promise<ApprovalRow | null> {
  const [row] = await updated(
    db,
    `update sa.approvals set status = $2, decided_by = $3, decided_at = now(), args = $4::text::jsonb,
       preview = coalesce($5::text::jsonb, preview)
     where id = $1 and status = 'pending' and approver_user_id = $3 and expires_at > now()
       and ${member("sa.approvals.chat_id", "$3")}`,
    [id, status, userId, JSON.stringify(args), preview ? JSON.stringify(preview) : null],
  );
  return row ?? null;
}

export async function finish(
  db: Db,
  id: string,
  status: "executed" | "failed",
  result: string,
): Promise<ApprovalRow | null> {
  const [row] = await updated(
    db,
    "update sa.approvals set status = $2, result = $3 where id = $1 and status = 'approved'",
    [id, status, result],
  );
  return row ?? null;
}

/** Only the requester cancels, and only while pending. */
export async function cancelPending(
  db: Db,
  id: string,
  userId: string,
): Promise<ApprovalRow | null> {
  const [row] = await updated(
    db,
    `update sa.approvals set status = 'canceled', decided_by = $2, decided_at = now()
     where id = $1 and status = 'pending' and requester_user_id = $2
       and ${member("sa.approvals.chat_id", "$2")}`,
    [id, userId],
  );
  return row ?? null;
}

export function expireDue(db: Db): Promise<ApprovalRow[]> {
  return updated(
    db,
    `update sa.approvals set status = 'expired', decided_at = now()
     where status = 'pending' and expires_at <= now()`,
    [],
  );
}

export function failInterrupted(db: Db): Promise<ApprovalRow[]> {
  return updated(
    db,
    `update sa.approvals set status = 'failed', result = 'The bridge restarted before this ran.'
     where status = 'approved'`,
    [],
  );
}

export async function hasGrant(
  db: Db,
  userId: string,
  agentId: string,
  tool: string,
): Promise<boolean> {
  const rows = await db.query(
    "select 1 from sa.approval_grants where user_id = $1 and agent_id = $2 and tool = $3",
    [userId, agentId, tool],
  );
  return rows.length > 0;
}

export async function insertGrant(
  db: Db,
  userId: string,
  agentId: string,
  tool: string,
): Promise<void> {
  await db.query(
    `insert into sa.approval_grants (user_id, agent_id, tool) values ($1, $2, $3)
     on conflict do nothing`,
    [userId, agentId, tool],
  );
}

export async function listGrants(db: Db, userId: string): Promise<ApprovalGrant[]> {
  const rows = await db.query<{ agent_id: string; agent_name: string; tool: string; ms: number }>(
    `select g.agent_id, a.name as agent_name, g.tool,
       (extract(epoch from g.created_at) * 1000)::float8 as ms
     from sa.approval_grants g join sa.agents a on a.id = g.agent_id
     where g.user_id = $1 order by g.created_at desc, g.tool`,
    [userId],
  );
  return rows.map((r) => ({
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    tool: r.tool,
    created_at: Math.round(Number(r.ms)),
  }));
}

export async function deleteGrant(
  db: Db,
  userId: string,
  agentId: string,
  tool: string,
): Promise<boolean> {
  const rows = await db.query(
    "delete from sa.approval_grants where user_id = $1 and agent_id = $2 and tool = $3 returning 1",
    [userId, agentId, tool],
  );
  return rows.length > 0;
}

/** Active human members of a chat (who receive public approval and question events). */
export async function humanMembers(db: Db, chatId: string): Promise<string[]> {
  const rows = await db.query<{ member_id: string }>(
    `select member_id from sa.chat_members
     where chat_id = $1 and member_type = 'user' and removed_at is null`,
    [chatId],
  );
  return rows.map((r) => r.member_id);
}

export async function isHumanMember(db: Db, chatId: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `select 1 from sa.chat_members
     where chat_id = $1 and member_type = 'user' and member_id = $2 and removed_at is null`,
    [chatId, userId],
  );
  return rows.length > 0;
}

export async function displayName(db: Db, userId: string): Promise<string> {
  const [u] = await db.query<{ display_name: string }>(
    "select display_name from sa.users where id = $1",
    [userId],
  );
  return u?.display_name ?? userId;
}
