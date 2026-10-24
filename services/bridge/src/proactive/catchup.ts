import type { AgentHostApi } from "../agents/api.js";
import type { Db } from "../db.js";

export const CATCHUP =
  "Give a short catch-up for the user: use chat_digest to see what happened in their chats since they were last here and reply with at most 3 short lines, most important first.";
export const WELCOME = (name: string) =>
  `This is a new direct chat with ${name}. Start with one line of hello that names ${name}, then give a 3-line catch-up on their chats using chat_digest.`;

/** Local calendar day of the Mac running the bridge, as YYYY-MM-DD. */
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type Deps = {
  db: Db;
  agentHost?: AgentHostApi | undefined;
  log: (m: string, x?: Record<string, unknown>) => void;
};

async function scribe(db: Db): Promise<string | undefined> {
  return (
    await db.query<{ id: string }>(
      "select id from sa.agents where roster_id = 'scribe' and scope = 'workspace'",
    )
  )[0]?.id;
}

/** Marks today as caught up; true when it was a new day. */
async function markToday(db: Db, userId: string): Promise<{ fresh: boolean; pauseAll: boolean }> {
  await db.query("insert into sa.user_prefs (user_id) values ($1) on conflict do nothing", [
    userId,
  ]);
  const today = localDay();
  const rows = await db.query<{ pause_all: boolean }>(
    `update sa.user_prefs set last_hello_day = $2::date
      where user_id = $1 and (last_hello_day is null or last_hello_day <> $2::date)
      returning pause_all`,
    [userId, today],
  );
  if (rows[0]) return { fresh: true, pauseAll: rows[0].pause_all };
  return { fresh: false, pauseAll: false };
}

export function makeCatchup(deps: Deps) {
  const { db, agentHost, log } = deps;
  const fire = (
    agentId: string,
    chatId: string,
    prompt: string,
    kind: "catchup" | "welcome",
    userId: string,
  ) => {
    void Promise.resolve(
      agentHost?.runProactive?.({ agentId, chatId, prompt, kind, requesterUserId: userId }),
    ).catch((e) => log("catch-up failed", { error: (e as Error).message }));
  };

  return {
    async onHello(userId: string): Promise<boolean> {
      const { fresh, pauseAll } = await markToday(db, userId);
      if (!fresh || pauseAll) return false;
      const agentId = await scribe(db);
      if (!agentId) return false;
      const [dm] = await db.query<{ id: string }>(
        `select c.id from sa.chats c
           join sa.chat_members u on u.chat_id = c.id and u.member_type = 'user' and u.member_id = $1 and u.removed_at is null
           join sa.chat_members a on a.chat_id = c.id and a.member_type = 'agent' and a.member_id = $2 and a.removed_at is null
          where c.kind = 'dm' order by c.created_at limit 1`,
        [userId, agentId],
      );
      if (!dm) return false;
      fire(agentId, dm.id, CATCHUP, "catchup", userId);
      return true;
    },

    async onAgentDm(
      userId: string,
      agentId: string,
      chatId: string,
      created: boolean,
    ): Promise<void> {
      if (!created || agentId !== (await scribe(db))) return;
      const [user] = await db.query<{ display_name: string }>(
        "select display_name from sa.users where id = $1",
        [userId],
      );
      if (!user) return;
      await markToday(db, userId);
      fire(agentId, chatId, WELCOME(user.display_name), "welcome", userId);
    },
  };
}
