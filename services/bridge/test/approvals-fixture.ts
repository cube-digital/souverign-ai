import type { AgentHostApi, ProactiveRequest } from "../src/agents/api.js";
import { hashToken } from "../src/auth.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Posted = {
  agentId: string;
  chatId: string;
  text: string;
  opts?: { replyTo?: string | null; meta?: Record<string, any> } | undefined;
};

/** pglite with users ana/bob/cy, a personal agent `nora` (owner ana), a workspace agent `max`,
 * and chat `c1` where ana, bob, nora and max are active members (cy is not). */
export async function approvalsWorld() {
  const db: Db = await openDb("pglite://memory");
  await migrate(db);
  for (const [id, name] of [
    ["ana", "Ana"],
    ["bob", "Bob"],
    ["cy", "Cy"],
  ]) {
    await db.query("insert into sa.users (id, display_name, pin_hash) values ($1, $2, 'x')", [
      id,
      name,
    ]);
    await db.query(
      "insert into sa.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')",
      [hashToken(`tok-${id}`), id],
    );
  }
  await db.query(
    "insert into sa.agents (id, owner_user_id, name, template, scope) values ('nora', 'ana', 'Nora', 'general', 'personal')",
  );
  await db.query(
    "insert into sa.agents (id, owner_user_id, name, template, scope, roster_id) values ('max', null, 'Max', 'ops', 'workspace', 'max')",
  );
  await db.query(
    "insert into sa.chats (id, title, kind, created_by) values ('c1', 'Project', 'group', 'ana')",
  );
  for (const [type, id] of [
    ["user", "ana"],
    ["user", "bob"],
    ["agent", "nora"],
    ["agent", "max"],
  ]) {
    await db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role) values ('c1', $1, $2, 'member')",
      [type, id],
    );
  }
  const posts: Posted[] = [];
  const proactive: ProactiveRequest[] = [];
  const host: AgentHostApi = {
    onAgentAdded: () => {},
    onAgentRemoved: () => {},
    postAs: async (agentId, chatId, text, opts) => {
      posts.push({ agentId, chatId, text, opts: opts as Posted["opts"] });
      return `m${posts.length}`;
    },
    runProactive: async (req) => {
      proactive.push(req);
      return true;
    },
  };
  return { db, host, posts, proactive };
}
