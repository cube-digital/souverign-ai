import {
  ArgsError,
  approvalDeps,
  ExecError,
  type Executor,
  type GatedToolSpec,
  requestApproval,
} from "../approvals/service.js";
import { displayName, humanMembers } from "../approvals/store.js";
import type { Db } from "../db.js";
import { type RegisteredTool, registerTools, type ToolCtx } from "../mcp/registry.js";
import { memory } from "./client.js";
import { loadScopeInput } from "./scope-input.js";
import { oneToOneHuman, recallScopes } from "./scopes.js";
import { addRecalls } from "./turn-recalls.js";

const TEMPLATES = ["general", "devops", "qa", "ops", "dev", "tech", "sales", "scribe"] as const;
const MAX_ITEMS = 5;
const NOTHING = "Nothing I know here matches that.";
const OFF = "Memory is off on this Mac.";
/** Memory source types an item kind may have been stored under. */
const SOURCE_TYPES: Record<string, string[]> = {
  document: ["doc", "document"],
  note: ["note"],
  correction: ["correction"],
};
const headId = (id: string) => id.split(".")[0] ?? id;

type Item = {
  id: string;
  kind: string;
  title: string;
  taught_by: string | null;
  origin_chat_id: string | null;
};

async function loadItems(db: Db, agentId: string, ids: string[]): Promise<Item[]> {
  if (ids.length === 0) return [];
  return db.query<Item>(
    "select id, kind, title, taught_by, origin_chat_id from sa.knowledge_items where agent_id = $1 and id = any($2) order by created_at, id",
    [agentId, ids],
  );
}

/** Removes the items from memory (all parts) and then from the table. */
async function deleteItems(db: Db, agentId: string, items: Item[]): Promise<void> {
  const mem = memory();
  if (!mem) throw new Error("memory is off");
  for (const it of items) {
    for (const source_type of SOURCE_TYPES[it.kind] ?? []) {
      await mem.deleteSource({
        namespace: `agent:${agentId}`,
        source_type,
        source_id: it.id,
        include_parts: true,
      });
    }
    await db.query("delete from sa.knowledge_items where id = $1 and agent_id = $2", [
      it.id,
      agentId,
    ]);
  }
}

async function forget(ctx: ToolCtx, args: Record<string, unknown>): Promise<string> {
  const about = typeof args.about === "string" ? args.about.trim() : "";
  if (about.length < 1 || about.length > 200) return "error: about must be 1 to 200 characters";
  const mem = memory();
  if (!mem) return OFF;
  const turn = ctx.turn;
  if (!ctx.chatId || !turn) return "This needs a chat turn.";
  if (!turn.requesterUserId) return "Someone has to ask me to forget things.";
  const input = await loadScopeInput(ctx.db, ctx.agentId, ctx.chatId, {
    noTaught: turn.noTaught,
    requesterUserId: turn.requesterUserId,
  });
  if (!input) return NOTHING;
  const own = `agent:${ctx.agentId}`;
  // D-9: the tool result names taught items and their teachers before any reply gate runs, so
  // taught knowledge (no origin chat) is searched only where it may be shared without asking.
  const taughtOk =
    input.agent.share === "always" || oneToOneHuman(input.agent, input.chat) !== null;
  // The origin filter is what bounds reach; the time bound is for reading history, not for
  // forgetting what the agent itself saved.
  const scopes = recallScopes(input)
    .filter((s) => s.namespace === own && (taughtOk || !(s.origin_chat_ids ?? []).includes(null)))
    .map(({ namespace, origin_chat_ids }) => ({
      namespace,
      origin_chat_ids: origin_chat_ids ?? null,
    }));
  if (scopes.length === 0) return NOTHING;
  let hits: Awaited<ReturnType<typeof mem.recall>>;
  try {
    hits = await mem.recall({ scopes, query: about, k: 8 });
  } catch {
    throw new Error("memory is unavailable");
  }
  // What the turn read counts for the share gate and the citations like any recall.
  addRecalls(turn.turnId, hits);
  const ids = [
    ...new Set(hits.filter((h) => h.space === own).map((h) => headId(h.source.id))),
  ].slice(0, MAX_ITEMS);
  const items = await loadItems(ctx.db, ctx.agentId, ids);
  if (items.length === 0) return NOTHING;

  const requester = turn.requesterUserId;
  const origins = new Set(scopes.flatMap((s) => s.origin_chat_ids ?? []).filter((o) => o !== null));
  // Free: taught by the requester, or the agent's own note born in a chat within this scope.
  const free = items.filter(
    (i) =>
      i.taught_by === requester ||
      (i.taught_by === null && i.origin_chat_id !== null && origins.has(i.origin_chat_id)),
  );
  const byTeacher = new Map<string, Item[]>();
  for (const i of items) {
    if (free.includes(i) || !i.taught_by) continue;
    byTeacher.set(i.taught_by, [...(byTeacher.get(i.taught_by) ?? []), i]);
  }
  const lines: string[] = [];
  approvalDeps().log("memory_forget", {
    agent: ctx.agentId,
    free: free.map((i) => i.id),
    asked: [...byTeacher.values()].flat().map((i) => i.id),
  });
  if (free.length > 0) {
    try {
      await deleteItems(ctx.db, ctx.agentId, free);
      lines.push(`Forgot: ${free.map((i) => `"${i.title}"`).join(", ")}.`);
    } catch {
      lines.push("I could not forget those right now.");
    }
  }
  const members = new Set(await humanMembers(ctx.db, ctx.chatId));
  for (const [teacher, list] of byTeacher) {
    const name = await displayName(ctx.db, teacher);
    const titles = list.map((i) => `"${i.title}"`).join(", ");
    if (!members.has(teacher)) {
      lines.push(`${name} taught me ${titles} but is not in this chat, so I cannot ask them.`);
      continue;
    }
    const r = await requestApproval({
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      replyTo: turn.replyTo ?? turn.triggerMessageId,
      turnId: turn.turnId,
      requesterUserId: requester,
      kind: "tool",
      tool: "memory_forget",
      args: { item_ids: list.map((i) => i.id), teacher_user_id: teacher },
    });
    lines.push(
      r.status === "pending"
        ? `Waiting for ${r.approval.approver_name} to approve forgetting ${titles}, because they taught me. Tell them it is waiting for their approval in this thread. Do not call the tool again.`
        : r.status === "error"
          ? r.message
          : `Could not forget ${titles}.`,
    );
  }
  return lines.join("\n");
}

const tool: RegisteredTool = {
  name: "memory_forget",
  description:
    "Forget what you were taught or noted about something. Your own notes go at once; what someone else taught needs that person's approval.",
  properties: { about: { type: "string", minLength: 1, maxLength: 200 } },
  required: ["about"],
  run: forget,
};

/** Registers the memory_forget MCP tool for every template (idempotent). */
export function registerForgetTool(): void {
  registerTools(TEMPLATES, [tool]);
}

const forgetExecutor: Executor = {
  editable: [],
  alwaysAllowed: false,
  stamp: true,
  async validate(args, ctx) {
    const teacher = typeof args.teacher_user_id === "string" ? args.teacher_user_id : "";
    const raw = Array.isArray(args.item_ids) ? args.item_ids : [];
    const ids = [...new Set(raw.filter((v): v is string => typeof v === "string"))].slice(
      0,
      MAX_ITEMS,
    );
    // Only items still taught by that person can be removed through their approval.
    const items = (await loadItems(ctx.db, ctx.agentId, ids)).filter(
      (i) => i.taught_by === teacher && teacher !== "",
    );
    if (teacher !== ctx.approverUserId) {
      throw new ArgsError("Only the person who taught this can approve.");
    }
    if (items.length === 0) throw new ArgsError("Those items are already gone.");
    return {
      item_ids: items.map((i) => i.id),
      teacher_user_id: teacher,
      titles: items.map((i) => i.title),
    };
  },
  preview(args) {
    const titles = (Array.isArray(args.titles) ? args.titles : []).map(String);
    return {
      title: "Forget what I was taught",
      target: titles.join(", ").slice(0, 200),
      fields: [
        {
          key: "items",
          label: "Items",
          value: titles.join("\n").slice(0, 8000),
          editable: false,
          multiline: true,
        },
      ],
      leaves_chat: false,
    };
  },
  async execute(args, ctx) {
    const ids = (Array.isArray(args.item_ids) ? args.item_ids : []).map(String);
    const items = (await loadItems(ctx.db, ctx.approval.agent_id, ids)).filter(
      (i) => i.taught_by === ctx.approval.approver_user_id,
    );
    if (items.length === 0) throw new ExecError("Those items are already gone.");
    await deleteItems(ctx.db, ctx.approval.agent_id, items);
    return `Forgot: ${items.map((i) => `"${i.title}"`).join(", ")}.`;
  },
  publicResult: () => "forgotten",
};

/** The approval is the teacher's: they decide, not the person who asked. */
export const forgetGatedTool: GatedToolSpec = {
  executor: forgetExecutor,
  approverRule: async (req) => String(req.args.teacher_user_id),
};
