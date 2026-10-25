import type { Approval, Citation, TextMeta } from "@sa/protocol";
import {
  FAIL_CLOSED_NOTICE,
  type ReplyDecision,
  type ReplyDraft,
  type TurnContext,
} from "../agents/turn-hooks.js";
import type { Db } from "../db.js";
import { loadScopeInput } from "../memory/scope-input.js";
import { oneToOneHuman } from "../memory/scopes.js";
import { recallsFor } from "../memory/turn-recalls.js";
import { subscribe } from "./events.js";
import {
  ArgsError,
  approvalDeps,
  ExecError,
  type Executor,
  formatTtl,
  requestApproval,
  withTimeout,
} from "./service.js";

export const SHARE_TOOL = "share_answer";
const MAX_TEXT = 8000;
const MAX_TEACHERS = 3;
const POSTED = "Posted.";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Agent sources without an origin chat: what people taught the agent on its Knowledge tab. */
const taughtSources = (meta: unknown): Citation[] => {
  const list = isObject(meta) && Array.isArray(meta.citations) ? meta.citations : [];
  return (list as Citation[]).filter((c) => c.space === "agent" && c.chat_id === undefined);
};

/** "Ana", "Ana and Bob", "Ana, Bob and Cleo" (deduped, at most 3). */
function teacherNames(sources: Citation[]): string {
  const names = [...new Set(sources.flatMap((c) => (c.taught_by ? [c.taught_by] : [])))].slice(
    0,
    MAX_TEACHERS,
  );
  if (names.length === 0) return "someone";
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Posts the held answer once it is approved; on deny the agent answers again without it. */
export const shareExecutor: Executor = {
  editable: ["text"],
  alwaysAllowed: false,
  stamp: false,
  async validate(args) {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text.trim()) throw new ArgsError("The answer is empty.");
    if (text.length > MAX_TEXT) throw new ArgsError("The answer is too long.");
    const meta = isObject(args.meta) ? args.meta : {};
    const question = typeof args.question === "string" ? args.question.slice(0, MAX_TEXT) : "";
    return { text, meta, question };
  },
  preview(args, info) {
    return {
      title: `Post an answer that uses taught knowledge in #${info.chatTitle}`.slice(0, 200),
      target: `#${info.chatTitle}`.slice(0, 200),
      fields: [
        {
          key: "text",
          label: "Answer",
          value: String(args.text ?? ""),
          editable: true,
          multiline: true,
        },
      ],
      sources: taughtSources(args.meta).slice(0, 8),
      leaves_chat: false,
    };
  },
  async execute(args, ctx) {
    const a = ctx.approval;
    if (!ctx.agentHost.postAs) throw new ExecError("The agent cannot post here.");
    const meta = { ...(args.meta as TextMeta), approved_by: ctx.approverName.slice(0, 80) };
    const id = await ctx.agentHost.postAs(a.agent_id, a.chat_id, String(args.text), {
      replyTo: a.reply_to,
      meta,
    });
    if (!id) throw new ExecError("The agent can no longer post in this chat.");
    return POSTED;
  },
  async onDenied(a, ctx) {
    // The retry is a whole turn; the decision does not wait for it.
    const retry = ctx.agentHost.runProactive?.({
      agentId: a.agent_id,
      chatId: a.chat_id,
      prompt: String(a.args.question ?? ""),
      kind: "retry",
      ...(a.requester_user_id ? { requesterUserId: a.requester_user_id } : {}),
      replyTo: a.reply_to,
      noTaught: true,
    });
    retry?.catch((e) =>
      approvalDeps().log("share retry failed", { id: a.id, error: (e as Error).name }),
    );
  },
};

/** The executor posts no stamps, so an expired preview gets its status line from here. */
const watchers = new Map<string, () => void>();

function unwatch(id: string): void {
  watchers.get(id)?.();
  watchers.delete(id);
}

async function expiredStamp(a: Approval): Promise<void> {
  const d = approvalDeps();
  if (!d.agentHost.postAs) return;
  const text = `Expired after ${formatTtl(a.expires_at - a.created_at)} without a decision · ${a.tool}`;
  try {
    const posted = withTimeout(
      d.agentHost.postAs(a.agent_id, a.chat_id, text, {
        replyTo: a.reply_to,
        meta: { approval: { id: a.id, status: a.status } },
      }),
    );
    if ((await posted) === undefined) d.log("share stamp timed out", { id: a.id });
  } catch (e) {
    d.log("share stamp failed", { id: a.id, error: (e as Error).name });
  }
}

/** Follows one pending share approval (via the approver's events) until it is decided. */
export function watchShare(a: { id: string; approver_user_id: string }): void {
  if (watchers.has(a.id)) return;
  const off = subscribe(a.approver_user_id, (e) => {
    if (e.type !== "approval" || e.approval.id !== a.id) return;
    const status = e.approval.status;
    if (status === "pending" || status === "approved") return;
    unwatch(a.id);
    if (status === "expired") void expiredStamp(e.approval);
  });
  watchers.set(a.id, off);
}

/** Picks up the previews still pending after a restart. */
export async function watchPendingShares(db: Db): Promise<void> {
  const rows = await db.query<{ id: string; approver_user_id: string }>(
    "select id, approver_user_id from sa.approvals where tool = $1 and status = 'pending'",
    [SHARE_TOOL],
  );
  for (const r of rows) watchShare(r);
}

export function stopShareWatchers(): void {
  for (const id of [...watchers.keys()]) unwatch(id);
}

const POST: ReplyDecision = { action: "post" };
/** Nothing of the answer (text, citations, the trace with recall results) may leave. */
const HIDDEN: Partial<TextMeta> = { citations: undefined, trace: undefined };
const failClosed = (): ReplyDecision => ({
  action: "hold",
  notice: FAIL_CLOSED_NOTICE,
  meta: { ...HIDDEN },
});

function logSafe(msg: string, extra: Record<string, unknown>): void {
  try {
    approvalDeps().log(msg, extra);
  } catch {
    // approvals are not initialised; the hold below is what matters
  }
}

/**
 * The D-9 `ask` gate fires on access: a turn in a shared chat that recalled taught knowledge
 * (`agent:<self>`, no origin chat) is held behind a share approval. Any failure past that point
 * holds the answer with FAIL_CLOSED_NOTICE; it never posts it.
 */
export async function beforeReply(ctx: TurnContext, draft: ReplyDraft): Promise<ReplyDecision> {
  const own = `agent:${ctx.agentId}`;
  const taught = recallsFor(ctx.turnId).some(
    (r) => r.hit.space === own && r.hit.origin_chat_id === null,
  );
  if (!taught) return POST;
  try {
    const { db } = approvalDeps();
    const inp = await loadScopeInput(db, ctx.agentId, ctx.chatId, {
      noTaught: ctx.noTaught,
      requesterUserId: ctx.requesterUserId,
    });
    if (!inp) return failClosed();
    if (oneToOneHuman(inp.agent, inp.chat) !== null) return POST;
    if (inp.agent.share === "always") return POST;
    // `never` (or a policy change during the turn): this answer must not be shared at all.
    if (inp.agent.share !== "ask") return failClosed();
    const res = await requestApproval({
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      replyTo: ctx.replyTo,
      turnId: ctx.turnId,
      requesterUserId: ctx.requesterUserId,
      kind: "share",
      tool: SHARE_TOOL,
      args: { text: draft.text, meta: draft.meta, question: ctx.prompt },
    });
    if (res.status !== "pending") {
      logSafe("share gate failed closed", {
        agent: ctx.agentId,
        status: res.status,
        ...(res.status === "error" ? { error: res.error } : {}),
      });
      return failClosed();
    }
    const a = res.approval;
    watchShare(a);
    const teachers = teacherNames(taughtSources(draft.meta));
    return {
      action: "hold",
      notice: `${ctx.agentName} prepared an answer that uses what ${teachers} taught it. Waiting for ${a.approver_name} to approve.`,
      meta: { ...HIDDEN, held: a.id },
    };
  } catch (e) {
    logSafe("share gate failed closed", { agent: ctx.agentId, error: (e as Error).name });
    return failClosed();
  }
}
