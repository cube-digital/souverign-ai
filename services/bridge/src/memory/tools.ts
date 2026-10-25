import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import { registerTools, type ToolCtx } from "../mcp/registry.js";
import { taughtByNames } from "./citations.js";
import { memory } from "./client.js";
import { loadScopeInput, taughtHeld } from "./scope-input.js";
import { recallScopes } from "./scopes.js";
import { addRecalls, type Numbered } from "./turn-recalls.js";

const TEMPLATES = ["general", "devops", "qa", "ops", "dev", "tech", "sales", "scribe"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OFF = "Memory is off on this Mac.";
const NEEDS_CHAT = "Memory needs a chat.";
const TAUGHT_HELD =
  "I can't save notes in this turn: it used taught knowledge that needs approval before it is shared here.";
const headId = (id: string) => id.split(".")[0] ?? id;
const nsId = (ns: string) => ns.slice(ns.indexOf(":") + 1);
const pad = (v: number) => String(v).padStart(2, "0");

function stamp(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function chatTitles(db: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db.query<{ id: string; title: string | null }>(
    "select id, title from sa.chats where id = any($1)",
    [ids],
  );
  for (const r of rows) out.set(r.id, r.title ?? "chat");
  return out;
}

async function renderHits(db: Db, numbered: Numbered[]): Promise<string> {
  const chatIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const { hit } of numbered) {
    if (hit.space.startsWith("chat:")) chatIds.add(nsId(hit.space));
    else {
      itemIds.add(headId(hit.source.id));
      if (hit.origin_chat_id) chatIds.add(hit.origin_chat_id);
    }
  }
  const titles = await chatTitles(db, [...chatIds]);
  const teachers = await taughtByNames(db, [...itemIds]);
  return numbered
    .map(({ n, hit }) => {
      const { source } = hit;
      const text = hit.text.replace(/\s+/g, " ").trim().slice(0, 400);
      let label: string;
      if (source.type === "message") {
        const chat = titles.get(nsId(hit.space)) ?? "chat";
        label = `#${chat} · ${source.title ?? "message"} · ${stamp(source.ts)}`;
      } else if (source.type === "note") {
        label = `note from #${titles.get(hit.origin_chat_id ?? "") ?? "chat"}`;
      } else if (source.type === "correction") {
        label = "correction";
      } else {
        label = source.title ?? source.type;
      }
      const who = hit.space.startsWith("agent:") ? teachers.get(headId(source.id)) : undefined;
      if (who) label += ` · taught by ${who}`;
      return `[${n}] "${text}"\n    source: ${label}`;
    })
    .join("\n");
}

async function recall(ctx: ToolCtx, args: Record<string, unknown>): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const k = args.k === undefined ? 5 : args.k;
  if (query.length < 1 || query.length > 500) return "error: query must be 1 to 500 characters";
  if (typeof k !== "number" || !Number.isInteger(k) || k < 1 || k > 8)
    return "error: k must be an integer from 1 to 8";
  const mem = memory();
  if (!mem) return OFF;
  if (!ctx.chatId || !ctx.turn) return NEEDS_CHAT;
  const { turn } = ctx;
  const input = await loadScopeInput(ctx.db, ctx.agentId, ctx.chatId, {
    noTaught: turn.noTaught,
    requesterUserId: ctx.requesterUserId ?? null,
  });
  if (!input) return "No memories matched.";
  const scopes = recallScopes(input);
  if (scopes.length === 0) return "No memories matched.";
  let hits: Awaited<ReturnType<typeof mem.recall>>;
  try {
    hits = await mem.recall({ scopes, query, k });
  } catch {
    throw new Error("memory is unavailable");
  }
  if (hits.length === 0) return "No memories matched.";
  const numbered = addRecalls(turn.turnId, hits);
  if (numbered.length === 0) return "No new memories matched.";
  return renderHits(ctx.db, numbered);
}

/** Control characters (newlines included) become spaces, so a tag stays on one line. */
function cleanTag(t: string): string {
  let out = "";
  for (const ch of t) {
    const c = ch.codePointAt(0) ?? 0;
    const ctrl = c < 32 || (c >= 127 && c <= 159) || c === 0x2028 || c === 0x2029;
    out += ctrl ? " " : ch;
  }
  return out.replace(/ +/g, " ").trim().slice(0, 40);
}

async function remember(ctx: ToolCtx, args: Record<string, unknown>): Promise<string> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (text.length < 1 || text.length > 1000) return "error: text must be 1 to 1000 characters";
  if (args.tags !== undefined && !Array.isArray(args.tags)) return "error: tags must be a list";
  const tags = ((args.tags ?? []) as unknown[])
    .filter((t): t is string => typeof t === "string")
    .map((t) => cleanTag(t))
    .filter((t) => t.length > 0)
    .slice(0, 8);
  const mem = memory();
  if (!mem) return OFF;
  if (!ctx.chatId) return NEEDS_CHAT;
  if (ctx.turn && (await taughtHeld(ctx.db, ctx.turn))) return TAUGHT_HELD;
  const id = randomBytes(10).toString("hex");
  const parts = JSON.stringify([{ label: null, text }]);
  await ctx.db.query(
    `insert into sa.knowledge_items (id, agent_id, kind, title, parts, tags, origin_chat_id, taught_by)
     values ($1, $2, 'note', $3, $4::jsonb, $5, $6, null)`,
    [id, ctx.agentId, text.slice(0, 80), parts, tags as string[], ctx.chatId],
  );
  try {
    await mem.ingest({
      namespace: `agent:${ctx.agentId}`,
      kind: "knowledge",
      origin_chat_id: ctx.chatId,
      source: { type: "note", id, title: text.slice(0, 80), ts: Date.now() },
      text: tags.length > 0 ? `${text}\n(tags: ${tags.join(", ")})` : text,
    });
  } catch {
    await ctx.db.query("delete from sa.knowledge_items where id = $1", [id]);
    return "I could not save that.";
  }
  return "Remembered. Members of this chat can see it on my Knowledge tab.";
}

/** Registers memory_recall and memory_remember for the roster templates (idempotent). */
export function registerMemoryTools(): void {
  registerTools(TEMPLATES, [
    {
      name: "memory_recall",
      description:
        "Search what you were taught and what was said in this chat since you joined. Cite results as [n].",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        k: { type: "integer", minimum: 1, maximum: 8 },
      },
      required: ["query"],
      run: recall,
    },
    {
      name: "memory_remember",
      description: "Save a short note to remember. Members of this chat can see it.",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 1000 },
        tags: { type: "array", maxItems: 5, items: { type: "string", maxLength: 24 } },
      },
      required: ["text"],
      run: remember,
    },
  ]);
}
