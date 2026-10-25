import type { Citation } from "@sa/protocol";
import type { Db } from "../db.js";
import type { Numbered } from "./turn-recalls.js";

const head = (id: string) => id.split(".")[0] ?? id;

/** Display names of the people who taught the given knowledge items (items without a teacher are absent). */
export async function taughtByNames(db: Db, itemIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (itemIds.length === 0) return out;
  const rows = await db.query<{ id: string; name: string }>(
    `select i.id, u.display_name as name
       from sa.knowledge_items i join sa.users u on u.id = i.taught_by
      where i.id = any($1)`,
    [itemIds],
  );
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

/** One citation per recalled source; `cited` when the reply text contains `[n]`. */
export async function toCitations(
  db: Db,
  numbered: Numbered[],
  replyText: string,
): Promise<Citation[]> {
  const agentItems = numbered
    .filter((r) => r.hit.space.startsWith("agent:") && r.hit.kind !== "meeting")
    .filter((r) => ["doc", "note", "correction", "file"].includes(r.hit.source.type))
    .map((r) => head(r.hit.source.id));
  const teachers = await taughtByNames(db, [...new Set(agentItems)]);
  return numbered.map(({ n, hit }) => {
    const { source } = hit;
    const c: Citation = {
      n,
      space: hit.space.startsWith("agent:") ? "agent" : "chat",
      kind: hit.kind,
      source_type: source.type as Citation["source_type"],
      source_id: source.id,
      title: source.title,
      ts: source.ts,
      cited: replyText.includes(`[${n}]`),
    };
    const ns = hit.space.slice(hit.space.indexOf(":") + 1);
    if (c.space === "chat") {
      c.chat_id = ns;
      c.message_id = head(source.id);
      return c;
    }
    if (!["doc", "note", "correction", "file"].includes(source.type)) return c;
    c.agent_id = ns;
    c.item_id = head(source.id);
    const page = /\.p(\d+)$/.exec(source.id);
    if (page) c.page = Number(page[1]);
    const who = teachers.get(c.item_id);
    if (who) c.taught_by = who;
    if (hit.origin_chat_id) c.chat_id = hit.origin_chat_id;
    return c;
  });
}
