import { randomBytes } from "node:crypto";
import type { CallInfo, CallSegment } from "@sa/protocol";
import type { Db } from "../db.js";
import { consentOf } from "./consent.js";

/** A failure with an HTTP status and a short code (`{error: code}`). */
export class CallError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429 | 503,
    readonly code: string,
  ) {
    super(code);
  }
}

const newId = (): string => randomBytes(9).toString("base64url");
const ms = (col: string): string => `(extract(epoch from ${col}) * 1000)::float8`;
const num = (v: unknown): number => Math.round(Number(v));

export type CallRow = {
  id: string;
  chat_id: string;
  room: string;
  started_by: string;
  started_ms: number;
  ended_ms: number | null;
  anchor_message_id: string | null;
  e2ee: boolean;
};
const CALL_COLS = `id, chat_id, room, started_by, ${ms("started_at")} as started_ms,
  ${ms("ended_at")} as ended_ms, anchor_message_id, e2ee`;

export async function callRow(db: Db, callId: string): Promise<CallRow | null> {
  const [r] = await db.query<CallRow>(`select ${CALL_COLS} from sa.calls where id = $1`, [callId]);
  return r ?? null;
}

export async function activeCallForChat(db: Db, chatId: string): Promise<string | null> {
  const [r] = await db.query<{ id: string }>(
    "select id from sa.calls where chat_id = $1 and ended_at is null",
    [chatId],
  );
  return r?.id ?? null;
}

/** Creates the chat's call, or returns the active one (`created: false`). */
export async function createCall(
  db: Db,
  chatId: string,
  userId: string,
  e2ee: boolean,
): Promise<{ id: string; created: boolean }> {
  const id = newId();
  const rows = await db.query<{ id: string }>(
    `insert into sa.calls (id, chat_id, room, started_by, e2ee) values ($1, $2, $3, $4, $5)
     on conflict do nothing returning id`,
    [id, chatId, `call-${id}`, userId, e2ee],
  );
  if (rows.length > 0) return { id, created: true };
  const active = await activeCallForChat(db, chatId);
  if (!active) throw new CallError(409, "call_conflict");
  return { id: active, created: false };
}

type NotetakerRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  invited_by: string;
  invited_by_name: string;
  invited_ms: number;
  status: "active" | "stopped" | "finished" | "failed";
  worker: "starting" | "joined" | "left" | "error" | "fake";
  stopped_by_name: string | null;
};

export async function latestNotetaker(db: Db, callId: string): Promise<NotetakerRow | null> {
  const [n] = await db.query<NotetakerRow>(
    `select n.id, n.agent_id, a.name as agent_name, n.invited_by, u.display_name as invited_by_name,
            ${ms("n.started_at")} as invited_ms, n.status, n.worker, s.display_name as stopped_by_name
       from sa.call_notetakers n
       join sa.agents a on a.id = n.agent_id
       join sa.users u on u.id = n.invited_by
       left join sa.users s on s.id = n.stopped_by
      where n.call_id = $1 order by n.started_at desc, n.id desc limit 1`,
    [callId],
  );
  return n ?? null;
}

/** SQL: the user (column) is an active human member of the call's chat (column). */
const activeMember = (chatCol: string, userCol: string): string =>
  `exists (select 1 from sa.chat_members m where m.chat_id = ${chatCol} and m.member_type = 'user'
     and m.member_id = ${userCol} and m.removed_at is null)`;

export async function getCallInfo(db: Db, callId: string): Promise<CallInfo | null> {
  const c = await callRow(db, callId);
  if (!c) return null;
  const n = await latestNotetaker(db, callId);
  const people = await db.query<{ user_id: string; name: string; in_call: boolean }>(
    `select p.user_id, u.display_name as name,
            (p.left_at is null and ${activeMember("$2", "p.user_id")}) as in_call
       from sa.call_participants p join sa.users u on u.id = p.user_id
      where p.call_id = $1 order by p.joined_at, p.user_id`,
    [callId, c.chat_id],
  );
  const decisions: Record<string, "accepted" | "declined"> = {};
  if (n) {
    const rows = await db.query<{ user_id: string; decision: "accepted" | "declined" }>(
      "select user_id, decision from sa.call_consents where notetaker_id = $1",
      [n.id],
    );
    for (const r of rows) decisions[r.user_id] = r.decision;
  }
  return {
    id: c.id,
    chat_id: c.chat_id,
    room: c.room,
    started_by: c.started_by,
    started_at: num(c.started_ms),
    ended_at: c.ended_ms === null ? null : num(c.ended_ms),
    anchor_message_id: c.anchor_message_id,
    e2ee: c.e2ee,
    participants: people.map((p) => ({
      user_id: p.user_id,
      name: p.name,
      in_call: p.in_call,
      consent: n ? consentOf(p.user_id, n.invited_by, decisions) : "pending",
    })),
    notetaker: n
      ? {
          id: n.id,
          agent_id: n.agent_id,
          agent_name: n.agent_name,
          invited_by: n.invited_by,
          invited_by_name: n.invited_by_name,
          invited_at: num(n.invited_ms),
          status: n.status,
          worker: n.worker,
          stopped_by_name: n.stopped_by_name,
        }
      : null,
  };
}

export async function setAnchor(db: Db, callId: string, messageId: string): Promise<boolean> {
  const rows = await db.query(
    "update sa.calls set anchor_message_id = $2 where id = $1 and anchor_message_id is null returning id",
    [callId, messageId],
  );
  return rows.length > 0;
}

export async function markJoined(db: Db, callId: string, userId: string): Promise<void> {
  await db.query(
    `insert into sa.call_participants (call_id, user_id) values ($1, $2)
     on conflict (call_id, user_id) do update set left_at = null`,
    [callId, userId],
  );
}

export async function markLeft(db: Db, callId: string, userId: string): Promise<void> {
  await db.query(
    "update sa.call_participants set left_at = now() where call_id = $1 and user_id = $2 and left_at is null",
    [callId, userId],
  );
}

export async function isParticipant(db: Db, callId: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    "select 1 from sa.call_participants where call_id = $1 and user_id = $2",
    [callId, userId],
  );
  return rows.length > 0;
}

export async function participantsInCall(db: Db, callId: string): Promise<string[]> {
  const rows = await db.query<{ user_id: string }>(
    `select p.user_id from sa.call_participants p join sa.calls c on c.id = p.call_id
      where p.call_id = $1 and p.left_at is null and ${activeMember("c.chat_id", "p.user_id")}`,
    [callId],
  );
  return rows.map((r) => r.user_id);
}

/** Ends the call. Returns the notetaker that was still active (now `finished`), if any. */
export async function endCall(
  db: Db,
  callId: string,
): Promise<{ ended: boolean; notetakerId: string | null }> {
  const ended = await db.query(
    "update sa.calls set ended_at = now() where id = $1 and ended_at is null returning id",
    [callId],
  );
  await db.query(
    "update sa.call_participants set left_at = now() where call_id = $1 and left_at is null",
    [callId],
  );
  const [n] = await db.query<{ id: string }>(
    `update sa.call_notetakers set status = 'finished', ended_at = now()
      where call_id = $1 and status = 'active' returning id`,
    [callId],
  );
  return { ended: ended.length > 0, notetakerId: n?.id ?? null };
}

/** The unique index allows one active notetaker per call (`409 notetaker_active`). */
export async function inviteNotetaker(
  db: Db,
  callId: string,
  agentId: string,
  inviterId: string,
): Promise<string> {
  const id = newId();
  try {
    await db.query(
      `with n as (
         insert into sa.call_notetakers (id, call_id, agent_id, invited_by) values ($1, $2, $3, $4)
         returning id)
       insert into sa.call_consents (notetaker_id, user_id, decision)
       select id, $4, 'accepted' from n`,
      [id, callId, agentId, inviterId],
    );
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (
      err.code === "23505" ||
      /duplicate key|call_notetakers_one_active/.test(err.message ?? "")
    ) {
      throw new CallError(409, "notetaker_active");
    }
    throw e;
  }
  return id;
}

export async function setConsent(
  db: Db,
  notetakerId: string,
  userId: string,
  decision: "accepted" | "declined",
): Promise<void> {
  await db.query(
    `insert into sa.call_consents (notetaker_id, user_id, decision) values ($1, $2, $3)
     on conflict (notetaker_id, user_id) do update set decision = $3, decided_at = now()`,
    [notetakerId, userId, decision],
  );
  // Withdrawing consent is retroactive: what that person said is deleted.
  if (decision === "declined") {
    await db.query(
      "delete from sa.call_segments where notetaker_id = $1 and speaker_user_id = $2",
      [notetakerId, userId],
    );
  }
}

/** Stops an active notetaker; false when it was not active. */
export async function stopNotetaker(db: Db, notetakerId: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `update sa.call_notetakers set status = 'stopped', stopped_by = $2, ended_at = now()
      where id = $1 and status = 'active' returning id`,
    [notetakerId, userId],
  );
  return rows.length > 0;
}

export async function failNotetaker(db: Db, notetakerId: string): Promise<boolean> {
  const rows = await db.query(
    `update sa.call_notetakers set status = 'failed', worker = 'error', ended_at = now()
      where id = $1 and status = 'active' returning id`,
    [notetakerId],
  );
  return rows.length > 0;
}

/** `user:<id>` for people who accepted and are in the call right now (empty unless active). */
export async function consentedIdentities(db: Db, notetakerId: string): Promise<string[]> {
  const rows = await db.query<{ user_id: string }>(
    `select c.user_id
       from sa.call_notetakers n
       join sa.call_consents c on c.notetaker_id = n.id and c.decision = 'accepted'
       join sa.call_participants p on p.call_id = n.call_id and p.user_id = c.user_id and p.left_at is null
       join sa.calls k on k.id = n.call_id
      where ${activeMember("k.chat_id", "c.user_id")} and n.id = $1 and n.status = 'active' order by c.user_id`,
    [notetakerId],
  );
  return rows.map((r) => `user:${r.user_id}`);
}

/** SQL: the segment's speaker is the inviter or currently accepted (`s` = segments, `n` = notetakers). */
export const CAPTURED = `(s.speaker_user_id = n.invited_by or exists (
  select 1 from sa.call_consents k where k.notetaker_id = n.id and k.user_id = s.speaker_user_id
    and k.decision = 'accepted'))`;

export async function segmentsOf(
  db: Db,
  notetakerId: string,
  callStartMs: number,
  sinceMs?: number,
): Promise<CallSegment[]> {
  const rows = await db.query<{
    id: number | string;
    speaker_user_id: string;
    speaker_name: string;
    t0_ms: number;
    text: string;
  }>(
    `select s.id, s.speaker_user_id, u.display_name as speaker_name, ${ms("s.t0")} as t0_ms, s.text
       from sa.call_segments s
       join sa.call_notetakers n on n.id = s.notetaker_id
       join sa.users u on u.id = s.speaker_user_id
      where s.notetaker_id = $1 and ${CAPTURED}
        and ($2::float8 is null or ${ms("s.t0")} >= $2::float8)
      order by s.t0, s.id`,
    [notetakerId, sinceMs ?? null],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    speaker_user_id: r.speaker_user_id,
    speaker_name: r.speaker_name,
    t_ms: Math.max(0, num(r.t0_ms) - callStartMs),
    text: r.text,
  }));
}

/** When the user first joined this call (epoch ms), if they ever did. */
export async function joinedAtMs(db: Db, callId: string, userId: string): Promise<number | null> {
  const [r] = await db.query<{ j: number }>(
    `select ${ms("joined_at")} as j from sa.call_participants where call_id = $1 and user_id = $2`,
    [callId, userId],
  );
  return r ? num(r.j) : null;
}

/** In the call right now (joined, not left) and still an active member of its chat. */
export async function isInCall(db: Db, callId: string, userId: string): Promise<boolean> {
  return (await participantsInCall(db, callId)).includes(userId);
}

/** Active calls whose participants include someone who is no longer an active chat member. */
export async function strandedParticipants(
  db: Db,
): Promise<Array<{ call_id: string; user_id: string }>> {
  return db.query(
    `select p.call_id, p.user_id from sa.call_participants p
       join sa.calls c on c.id = p.call_id and c.ended_at is null
      where p.left_at is null and not ${activeMember("c.chat_id", "p.user_id")}`,
  );
}

/** Active human membership of a chat. */
export async function isActiveMember(db: Db, chatId: string, userId: string): Promise<boolean> {
  const [r] = await db.query(`select 1 where ${activeMember("$1", "$2")}`, [chatId, userId]);
  return r !== undefined;
}

export async function notetakerCall(
  db: Db,
  notetakerId: string,
): Promise<{ call_id: string; status: string } | null> {
  const [r] = await db.query<{ call_id: string; status: string }>(
    "select call_id, status from sa.call_notetakers where id = $1",
    [notetakerId],
  );
  return r ?? null;
}

export async function latestNotes(db: Db, notetakerId: string) {
  const [r] = await db.query<{
    id: string;
    version: number;
    final: boolean;
    body_md: string;
    action_items: unknown;
    status: "draft" | "pending_approval" | "published" | "not_published";
    approval_id: string | null;
  }>(
    `select id, version, final, body_md, action_items, status, approval_id
       from sa.call_notes where notetaker_id = $1 order by version desc limit 1`,
    [notetakerId],
  );
  if (!r) return null;
  const items = typeof r.action_items === "string" ? JSON.parse(r.action_items) : r.action_items;
  return { ...r, version: Number(r.version), action_items: items as never[] };
}
