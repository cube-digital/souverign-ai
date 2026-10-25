import type { Db } from "../db.js";
import type { ToolCtx } from "../mcp/registry.js";

const NONE = { error: "no_call_notes_here" };
const MAX_LINES = 300;
const MAX_QUERY_LINES = 60;
const MAX_NOTES = 20_000;
/** In the inviter's DM only the most recent calls are offered. */
const DM_RECENT = 2;

type CallRow = {
  id: string;
  notetaker_id: string;
  chat_id: string;
  chat_title: string | null;
  started_at: string;
  ended_at: string | null;
};
type NoteRow = { body_md: string; action_items: unknown; status: string };
type SegRow = { speaker: string; t0: string; text: string };

const pad = (n: number) => String(n).padStart(2, "0");
const offset = (from: string, t: string): string => {
  const s = Math.max(0, Math.floor((Date.parse(t) - Date.parse(from)) / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

const CALL_SQL = `select c.id as id, n.id as notetaker_id, c.chat_id, ch.title as chat_title,
    c.started_at::text as started_at, c.ended_at::text as ended_at
  from sa.calls c
  join sa.call_notetakers n on n.call_id = c.id and n.agent_id = $1
  join sa.chats ch on ch.id = c.chat_id`;

async function chatIsDmOf(db: Db, chatId: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `select 1 from sa.chats ch
     join sa.chat_members m on m.chat_id = ch.id and m.member_type = 'user' and m.member_id = $2
     where ch.id = $1 and ch.kind = 'dm'`,
    [chatId, userId],
  );
  return rows.length > 0;
}

async function latestNote(db: Db, notetakerId: string, publishedOnly: boolean) {
  const [row] = await db.query<NoteRow>(
    `select body_md, action_items, status from sa.call_notes
     where notetaker_id = $1 ${publishedOnly ? "and status = 'published'" : ""}
     order by version desc limit 1`,
    [notetakerId],
  );
  return row;
}

async function segments(db: Db, notetakerId: string): Promise<SegRow[]> {
  return db.query<SegRow>(
    `select u.display_name as speaker, s.t0::text as t0, s.text
     from sa.call_segments s
     join sa.users u on u.id = s.speaker_user_id
     join sa.call_consents k on k.notetaker_id = s.notetaker_id and k.user_id = s.speaker_user_id
       and k.decision = 'accepted'
     where s.notetaker_id = $1 order by s.t0, s.id`,
    [notetakerId],
  );
}

function pick(
  lines: { t: string; speaker: string; text: string }[],
  query: string,
): { lines: typeof lines; truncated: boolean } {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  if (words.length === 0) {
    return { lines: lines.slice(-MAX_LINES), truncated: lines.length > MAX_LINES };
  }
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (words.some((w) => l.text.toLowerCase().includes(w))) {
      for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j);
    }
  });
  const idx = [...keep].sort((a, b) => a - b);
  return {
    lines: idx.slice(0, MAX_QUERY_LINES).flatMap((i) => (lines[i] ? [lines[i]] : [])),
    truncated: idx.length > MAX_QUERY_LINES,
  };
}

/** Chat and requester come from the turn (ToolCtx), never from args. Returns a JSON-serialisable object. */
export async function meetingTranscript(
  db: Db,
  ctx: ToolCtx,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { chatId, requesterUserId: who } = ctx;
  if (!chatId || !who) return NONE;
  const callId = typeof args.call_id === "string" ? args.call_id : undefined;
  const query = str(args.query, 200).trim();
  const dm = await chatIsDmOf(db, chatId, who);

  let calls: CallRow[];
  if (dm) {
    calls = await db.query<CallRow>(
      `${CALL_SQL} where n.invited_by = $2 order by c.started_at desc limit ${DM_RECENT}`,
      [ctx.agentId, who],
    );
  } else {
    const chat = await db.query(
      "select 1 from sa.chat_members where chat_id = $1 and member_type = 'user' and member_id = $2",
      [chatId, who],
    );
    if (chat.length === 0) return NONE;
    calls = await db.query<CallRow>(
      `${CALL_SQL} where c.chat_id = $2
         and exists (select 1 from sa.call_notes p where p.notetaker_id = n.id and p.status = 'published')
       order by c.started_at desc limit 10`,
      [ctx.agentId, chatId],
    );
  }
  const call = callId ? calls.find((c) => c.id === callId) : calls[0];
  if (!call) return NONE;
  const note = await latestNote(db, call.notetaker_id, !dm);
  if (!note) return NONE;

  const segs = await segments(db, call.notetaker_id);
  const speakers = [...new Set(segs.map((s) => s.speaker))];
  const [missing] = await db.query<{ n: number }>(
    `select count(*)::int as n from sa.call_participants p
     where p.call_id = $1 and not exists (
       select 1 from sa.call_consents k where k.notetaker_id = $2 and k.user_id = p.user_id and k.decision = 'accepted')`,
    [call.id, call.notetaker_id],
  );
  const started = Date.parse(call.started_at);
  const ended = call.ended_at ? Date.parse(call.ended_at) : started;
  const out: Record<string, unknown> = {
    call_id: call.id,
    chat_title: call.chat_title ?? "chat",
    started_at: call.started_at,
    duration_min: Math.max(0, Math.round((ended - started) / 60_000)),
    speakers,
    not_captured: missing?.n ?? 0,
    notes_md: str(note.body_md, MAX_NOTES),
    action_items: note.action_items,
    published: note.status === "published",
    calls: calls.map((c) => ({ call_id: c.id, started_at: c.started_at })),
  };
  if (dm) {
    const all = segs.map((s) => ({
      t: offset(call.started_at, s.t0),
      speaker: s.speaker,
      text: s.text,
    }));
    const { lines, truncated } = pick(all, query);
    out.transcript = lines;
    out.truncated = truncated;
  }
  return out;
}
