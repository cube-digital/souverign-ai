import type { Db } from "../db.js";

export type TurnOutcome = "done" | "stopped" | "error" | "timeout" | "skipped";

export type TurnMetrics = {
  turnId: string;
  agentId: string;
  chatId: string;
  threadRoot: string | null;
  requesterUserId: string | null;
  trigger: string;
  queuedMs: number | null;
  eyesMs: number | null;
  firstTokenMs: number | null;
  doneMs: number | null;
  tools: number;
  outcome: TurnOutcome;
};

const REASK_WINDOW = "10 minutes";

/** One row per turn: ids and timings only, never message text. */
export async function recordTurn(db: Db, m: TurnMetrics): Promise<void> {
  await db.query(
    `insert into sa.turn_metrics
       (turn_id, agent_id, chat_id, thread_root, requester_user_id, trigger,
        queued_ms, eyes_ms, first_token_ms, done_ms, tools, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (turn_id) do nothing`,
    [
      m.turnId,
      m.agentId,
      m.chatId,
      m.threadRoot,
      m.requesterUserId,
      m.trigger,
      m.queuedMs,
      m.eyesMs,
      m.firstTokenMs,
      m.doneMs,
      m.tools,
      m.outcome,
    ],
  );
}

/** The same person asking the same agent again in the same thread within 10 minutes of a
 * finished turn means that turn did not satisfy them. */
export async function markReask(
  db: Db,
  t: {
    turnId: string;
    agentId: string;
    chatId: string;
    threadRoot: string | null;
    requesterUserId: string;
  },
): Promise<void> {
  await db.query(
    `update sa.turn_metrics set reask = true
     where turn_id = (
       select turn_id from sa.turn_metrics
       where agent_id = $1 and chat_id = $2 and thread_root is not distinct from $3
         and requester_user_id = $4 and outcome = 'done' and turn_id <> $5
         and created_at > now() - interval '${REASK_WINDOW}'
       order by created_at desc limit 1)`,
    [t.agentId, t.chatId, t.threadRoot, t.requesterUserId, t.turnId],
  );
}

/** Sets or clears 👍/👎 on the turn whose reply (sent by this agent device) was reacted to. */
export async function setFeedback(
  db: Db,
  r: { deviceId: string; chatId: string; target: string; emoji: string; op: "add" | "remove" },
): Promise<void> {
  const value = r.emoji === "👍" ? "up" : r.emoji === "👎" ? "down" : null;
  if (!value) return;
  const [reply] = await db.query<{ turn_id: string | null }>(
    `select body->'meta'->>'turn_id' as turn_id from sa.messages_plain
     where device_id = $1 and id = $2 and sender_device = $1 and chat_id = $3`,
    [r.deviceId, r.target, r.chatId],
  );
  if (!reply?.turn_id) return;
  if (r.op === "add") {
    await db.query("update sa.turn_metrics set feedback = $2 where turn_id = $1", [
      reply.turn_id,
      value,
    ]);
  } else {
    await db.query(
      "update sa.turn_metrics set feedback = null where turn_id = $1 and feedback = $2",
      [reply.turn_id, value],
    );
  }
}
