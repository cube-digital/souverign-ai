import type { ChatEngine } from "@sa/client";
import { rosterEntry, TEMPLATE_INFO } from "@sa/protocol/roster";
import type { Db } from "../db.js";

const KEY_WAIT_MS = 30_000;
const SETTLE_MS = 1500;

/** Posts the agent's one-time introduction in a group or room chat once it holds the chat key.
 * No model is involved. Seeded rooms (their card does this job) and DMs get none. */
export async function postIntro(args: {
  db: Db;
  engine: ChatEngine;
  agent: { id: string; name: string; template: string };
  chatId: string;
  /** false once the device was closed, so the wait stops */
  alive: () => boolean;
  /** runs the post after the agent's own in-flight turns, so it never interrupts an answer */
  afterTurns: (post: () => Promise<boolean>) => Promise<boolean>;
}): Promise<boolean> {
  const { db, engine, agent, chatId } = args;
  const [chat] = await db.query<{ kind: string; seed_key: string | null }>(
    "select kind, seed_key from sa.chats where id = $1",
    [chatId],
  );
  if (!chat || chat.seed_key || (chat.kind !== "group" && chat.kind !== "room")) return false;
  const [row] = await db.query<{ roster_id: string | null; template: string }>(
    "select roster_id, template from sa.agents where id = $1",
    [agent.id],
  );
  if (!row) return false;
  const deadline = Date.now() + KEY_WAIT_MS;
  while ((await engine.latestEpoch(chatId)) <= 0) {
    if (Date.now() >= deadline || !args.alive()) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Let a first question that arrives with the key be answered before the agent speaks up.
  await args.afterTurns(async () => true);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  if (!args.alive()) return false;
  return args.afterTurns(async () => {
    const claimed = await db.query(
      `insert into sa.agent_intros (agent_id, chat_id) values ($1, $2)
       on conflict do nothing returning agent_id`,
      [agent.id, chatId],
    );
    if (claimed.length === 0) return false;
    // The agent may have been removed while it waited for the key or for its turns.
    const [member] = await db.query(
      "select 1 from sa.chat_members where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null",
      [chatId, agent.id],
    );
    if (!member) {
      await db.query("delete from sa.agent_intros where agent_id = $1 and chat_id = $2", [
        agent.id,
        chatId,
      ]);
      return false;
    }
    const roster = rosterEntry(row.roster_id);
    const role = roster?.role ?? "personal assistant";
    const examples =
      roster?.examples ?? (TEMPLATE_INFO[row.template] ?? TEMPLATE_INFO.general)?.examples;
    try {
      await engine.sendText(chatId, `${agent.name} · ${role}. Ask me, for example:`, {
        trigger: "intro",
        chips: examples ? [...examples] : [],
        local: true,
      });
      return true;
    } catch (e) {
      await db.query("delete from sa.agent_intros where agent_id = $1 and chat_id = $2", [
        agent.id,
        chatId,
      ]);
      throw e;
    }
  });
}
