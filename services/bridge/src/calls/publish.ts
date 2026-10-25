import { randomBytes } from "node:crypto";
import type { MessageBody } from "@sa/protocol";
import { publish } from "../approvals/events.js";
import {
  type ApproverRule,
  ArgsError,
  approvalDeps,
  ExecError,
  type Executor,
  requestApproval,
} from "../approvals/service.js";
import { humanMembers } from "../approvals/store.js";
import type { Db } from "../db.js";
import { memory } from "../memory/client.js";
import type { RelayAdmin } from "../relay-admin.js";
import type { FinalNotes } from "./scheduler.js";
import { parseActionItems } from "./summary.js";

export const NOTES_TOOL = "call_notes_publish";
export const NOTES_TTL_MS = 24 * 60 * 60 * 1000;
const REMIND_AFTER_MS = 20 * 60 * 60 * 1000;
const REPUBLISH_WITHIN_DAYS = 7;
const MAX_TEXT = 7900;

let relayAdmin: RelayAdmin | undefined;
/** The plugin hands over the relay admin so a missing DM with Scribe can be created. */
export function configurePublish(o: { relayAdmin: RelayAdmin }): void {
  relayAdmin = o.relayAdmin;
}

type NotesInfo = {
  status: string;
  call_id: string;
  chat_id: string;
  chat_title: string | null;
  agent_id: string;
  invited_by: string;
  anchor: string | null;
  started_ms: number;
};
async function notesInfo(db: Db, notesId: string): Promise<NotesInfo | undefined> {
  const [r] = await db.query<NotesInfo>(
    `select n.status, nt.call_id, c.chat_id, ch.title as chat_title, nt.agent_id, nt.invited_by,
            c.anchor_message_id as anchor, (extract(epoch from c.started_at) * 1000)::float8 as started_ms
       from sa.call_notes n
       join sa.call_notetakers nt on nt.id = n.notetaker_id
       join sa.calls c on c.id = nt.call_id
       join sa.chats ch on ch.id = c.chat_id
      where n.id = $1`,
    [notesId],
  );
  return r;
}

const dateOf = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-GB", { dateStyle: "medium" });

export const approverRule: ApproverRule = async (req, db) => {
  const id = typeof req.args.notes_id === "string" ? req.args.notes_id : "";
  const [r] = await db.query<{ invited_by: string }>(
    `select nt.invited_by from sa.call_notes n
       join sa.call_notetakers nt on nt.id = n.notetaker_id where n.id = $1`,
    [id],
  );
  return r?.invited_by ?? null;
};

export const callNotesExecutor: Executor = {
  editable: ["text"],
  alwaysAllowed: false,
  stamp: false,
  async validate(args, ctx) {
    const notesId = String(args.notes_id ?? "");
    const info = await notesInfo(ctx.db, notesId);
    if (!info || info.call_id !== args.call_id) throw new ArgsError("These notes no longer exist.");
    if (info.status !== "pending_approval") {
      throw new ArgsError("These notes are not waiting for approval.");
    }
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (text.length < 1 || text.length > MAX_TEXT) {
      throw new ArgsError(`text must be 1 to ${MAX_TEXT} characters.`);
    }
    return {
      chat_id: info.chat_id,
      chat_title: info.chat_title ?? "chat",
      call_id: info.call_id,
      notes_id: notesId,
      text,
    };
  },
  preview(args) {
    const title = String(args.chat_title ?? "chat");
    return {
      title: `Post call notes in #${title}`.slice(0, 200),
      target: `#${title} · call thread`.slice(0, 200),
      fields: [
        {
          key: "text",
          label: "Notes",
          value: String(args.text ?? "").slice(0, 8000),
          editable: true,
          multiline: true,
        },
      ],
      leaves_chat: true,
    };
  },
  async execute(args, ctx) {
    const chatId = String(args.chat_id);
    const callId = String(args.call_id);
    const text = String(args.text);
    const title = String(args.chat_title ?? "chat");
    const agentId = ctx.approval.agent_id;
    const [member] = await ctx.db.query(
      `select 1 from sa.chat_members where chat_id = $1 and member_type = 'agent'
         and member_id = $2 and removed_at is null`,
      [chatId, agentId],
    );
    if (!member) throw new ExecError("notetaker_not_in_chat");
    const send = ctx.agentHost.sendAs;
    if (!send) throw new ExecError("I can't post right now.");
    const info = await notesInfo(ctx.db, String(args.notes_id));
    if (!info) throw new ExecError("These notes no longer exist.");
    const body: MessageBody = {
      type: "text",
      text,
      ...(info.anchor ? { reply_to: info.anchor } : {}),
      meta: { meeting: { call_id: callId, action_items: parseActionItems(text) } },
    };
    const messageId = await send.call(ctx.agentHost, agentId, chatId, body);
    await ctx.db.query(
      `update sa.call_notes set status = 'published', published_message_id = $2
        where id = $1 and status = 'pending_approval'`,
      [String(args.notes_id), messageId],
    );
    const started = Math.round(Number(info.started_ms));
    let memoryOk = false;
    try {
      const mem = memory();
      if (mem) {
        await mem.ingest({
          namespace: `chat:${chatId}`,
          kind: "meeting",
          origin_chat_id: chatId,
          source: {
            type: "meeting",
            id: callId,
            title: `Call notes ${dateOf(started)}`,
            ts: started,
          },
          text,
        });
        memoryOk = true;
      }
    } catch (e) {
      approvalDeps().log("call notes ingest failed", { call: callId, error: (e as Error).name });
    }
    const when = new Date(started).toLocaleString("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    publish(await humanMembers(ctx.db, chatId), {
      type: "call.notes_published",
      call_id: callId,
      chat_id: chatId,
      message_id: messageId,
      title: `${title} call · ${when}`.slice(0, 200),
    });
    return `Posted call notes in #${title}${memoryOk ? "" : " · memory failed"}`;
  },
  async onDenied(approval, ctx) {
    await markNotPublished(ctx.db, String(approval.args.notes_id ?? ""));
  },
};

/** The inviter's DM with Scribe; created through the relay when missing. Null when it cannot be. */
async function ensureDm(db: Db, userId: string, agentId: string): Promise<string | null> {
  const [existing] = await db.query<{ id: string }>(
    `select c.id from sa.chats c
       join sa.chat_members me on me.chat_id = c.id and me.member_type = 'user'
        and me.member_id = $1 and me.removed_at is null
       join sa.chat_members ag on ag.chat_id = c.id and ag.member_type = 'agent'
        and ag.member_id = $2 and ag.removed_at is null
      where c.kind = 'dm'
        and (select count(*) from sa.chat_members x where x.chat_id = c.id and x.removed_at is null) = 2
      order by c.created_at, c.id limit 1`,
    [userId, agentId],
  );
  if (existing) return existing.id;
  if (!relayAdmin) return null;
  const devices = await db.query<{ id: string }>(
    "select id from sa.devices where owner_type = 'user' and owner_id = $1",
    [userId],
  );
  const [agent] = await db.query<{ name: string; device_id: string }>(
    "select name, device_id from sa.agents where id = $1",
    [agentId],
  );
  if (devices.length === 0 || !agent) return null;
  const chatId = randomBytes(12).toString("base64url");
  for (const d of devices)
    await relayAdmin.setMember({ chat_id: chatId, device_id: d.id, op: "add" });
  await relayAdmin.setMember({ chat_id: chatId, device_id: agent.device_id, op: "add" });
  await db.query(
    "insert into sa.chats (id, title, kind, created_by, key_epoch) values ($1, $2, 'dm', $3, 1)",
    [chatId, agent.name, userId],
  );
  await db.query(
    "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'user', $2, 'owner'), ($1, 'agent', $3, 'member')",
    [chatId, userId, agentId],
  );
  await approvalDeps().agentHost.onAgentAdded(chatId, agentId);
  return chatId;
}

/** Notes pending approval become not_published (once) and the inviter gets one DM. */
async function markNotPublished(
  db: Db,
  notesId: string,
  fallbackDm?: { chatId: string; agentId: string },
): Promise<void> {
  const [row] = await db.query<{
    call_id: string;
    chat_title: string | null;
    dm_chat: string | null;
    agent_id: string;
  }>(
    `with u as (
       update sa.call_notes set status = 'not_published'
        where id = $1 and status = 'pending_approval' returning id, notetaker_id, approval_id)
     select nt.call_id, ch.title as chat_title, ap.chat_id as dm_chat, nt.agent_id
       from u join sa.call_notetakers nt on nt.id = u.notetaker_id
       join sa.calls c on c.id = nt.call_id
       join sa.chats ch on ch.id = c.chat_id
       left join sa.approvals ap on ap.id = u.approval_id`,
    [notesId],
  );
  if (!row) return;
  const d = approvalDeps();
  const dm = row.dm_chat ?? fallbackDm?.chatId;
  d.log("call notes not published", { notes: notesId });
  if (!dm || !d.agentHost.postAs) return;
  try {
    await d.agentHost.postAs(
      fallbackDm?.agentId ?? row.agent_id,
      dm,
      `The notes from the call in #${row.chat_title ?? "chat"} were not published.`,
      { meta: { call_notes: { call_id: row.call_id, notes_id: notesId, state: "not_published" } } },
    );
  } catch (e) {
    d.log("call notes dm failed", { notes: notesId, error: (e as Error).name });
  }
}

/** Requests the 24 h approval for notes already marked pending_approval. */
async function requestFor(notesId: string, text: string): Promise<string | null> {
  const d = approvalDeps();
  const info = await notesInfo(d.db, notesId);
  if (!info) return null;
  const dm = await ensureDm(d.db, info.invited_by, info.agent_id);
  if (!dm) {
    d.log("call notes: no dm with the notetaker", { notes: notesId });
    return null;
  }
  const r = await requestApproval({
    agentId: info.agent_id,
    chatId: dm,
    replyTo: null,
    turnId: null,
    requesterUserId: info.invited_by,
    kind: "tool",
    tool: NOTES_TOOL,
    args: { chat_id: info.chat_id, call_id: info.call_id, notes_id: notesId, text },
    ttlMs: NOTES_TTL_MS,
  });
  if (r.status === "error") {
    d.log("call notes approval refused", { notes: notesId, error: r.error });
    return null;
  }
  await d.db.query(
    `update sa.call_notes set approval_id = $2, approval_requested_at = now(), reminded_at = null
      where id = $1`,
    [notesId, r.approval.id],
  );
  return r.approval.id;
}

/** The final notes of a call become one approval for the inviter, in the inviter's DM with Scribe. */
export async function onFinalNotes(notes: FinalNotes): Promise<void> {
  const d = approvalDeps();
  await d.db.query(
    "update sa.call_notes set status = 'pending_approval', approval_requested_at = now() where id = $1 and status = 'draft'",
    [notes.id],
  );
  const id = await requestFor(notes.id, notes.bodyMd).catch((e) => {
    d.log("call notes request failed", { notes: notes.id, error: (e as Error).name });
    return null;
  });
  if (!id) {
    const [nt] = await d.db.query<{ agent_id: string }>(
      "select agent_id from sa.call_notetakers where id = $1",
      [notes.notetakerId],
    );
    const dm = nt ? await ensureDm(d.db, notes.invitedBy, nt.agent_id).catch(() => null) : null;
    await markNotPublished(
      d.db,
      notes.id,
      dm && nt ? { chatId: dm, agentId: nt.agent_id } : undefined,
    );
  }
}

export type RepublishResult =
  | { ok: true; approvalId: string }
  | { ok: false; status: 403 | 404 | 409; code: string };

export async function republish(notesId: string, userId: string): Promise<RepublishResult> {
  const d = approvalDeps();
  const info = await notesInfo(d.db, notesId);
  if (!info) return { ok: false, status: 404, code: "not_found" };
  if (info.invited_by !== userId) return { ok: false, status: 403, code: "notes_private" };
  const tooOld = Date.now() - Number(info.started_ms) > REPUBLISH_WITHIN_DAYS * 86_400_000;
  if (info.status !== "not_published" || tooOld) {
    return { ok: false, status: 409, code: "not_republishable" };
  }
  // The guarded update lets exactly one click through.
  const [claimed] = await d.db.query<{ body_md: string }>(
    `update sa.call_notes set status = 'pending_approval', approval_requested_at = now(), reminded_at = null
      where id = $1 and status = 'not_published' returning body_md`,
    [notesId],
  );
  if (!claimed) return { ok: false, status: 409, code: "not_republishable" };
  const id = await requestFor(notesId, claimed.body_md).catch(() => null);
  if (!id) {
    await d.db.query(
      "update sa.call_notes set status = 'not_published' where id = $1 and status = 'pending_approval'",
      [notesId],
    );
    return { ok: false, status: 409, code: "not_republishable" };
  }
  return { ok: true, approvalId: id };
}

/** Finds denied or expired approvals and sends the 20 h reminder; safe to run as often as you like. */
export async function sweep(nowMs: number): Promise<void> {
  const d = approvalDeps();
  const dead = await d.db.query<{ id: string }>(
    `select n.id from sa.call_notes n join sa.approvals a on a.id = n.approval_id
      where n.status = 'pending_approval' and a.status in ('expired', 'denied', 'failed', 'canceled')`,
  );
  for (const n of dead) await markNotPublished(d.db, n.id);

  const due = await d.db.query<{
    id: string;
    call_id: string;
    chat_title: string | null;
    started_ms: number;
    requested_ms: number;
    dm_chat: string;
    agent_id: string;
  }>(
    `select n.id, nt.call_id, ch.title as chat_title, (extract(epoch from c.started_at) * 1000)::float8 as started_ms,
            (extract(epoch from n.approval_requested_at) * 1000)::float8 as requested_ms,
            a.chat_id as dm_chat, a.agent_id
       from sa.call_notes n
       join sa.approvals a on a.id = n.approval_id and a.status = 'pending'
       join sa.call_notetakers nt on nt.id = n.notetaker_id
       join sa.calls c on c.id = nt.call_id
       join sa.chats ch on ch.id = c.chat_id
      where n.status = 'pending_approval' and n.reminded_at is null and n.approval_requested_at is not null`,
  );
  for (const n of due) {
    if (nowMs - Number(n.requested_ms) < REMIND_AFTER_MS) continue;
    const [won] = await d.db.query(
      `update sa.call_notes set reminded_at = now()
        where id = $1 and reminded_at is null and status = 'pending_approval' returning id`,
      [n.id],
    );
    if (!won || !d.agentHost.postAs) continue;
    try {
      await d.agentHost.postAs(
        n.agent_id,
        n.dm_chat,
        `Your notes from the call in #${n.chat_title ?? "chat"} (${dateOf(Math.round(Number(n.started_ms)))}) are still waiting for your approval. They expire in 4 hours.`,
        { meta: { call_notes: { call_id: n.call_id, notes_id: n.id, state: "pending" } } },
      );
    } catch (e) {
      d.log("call notes reminder failed", { notes: n.id, error: (e as Error).name });
    }
  }
}
