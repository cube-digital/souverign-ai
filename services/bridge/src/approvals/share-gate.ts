import type { Approval, Citation, TextMeta } from "@sa/protocol";
import type { ReplyDecision, ReplyDraft, TurnContext } from "../agents/turn-hooks.js";
import type { Db } from "../db.js";
import { loadScopeInput } from "../memory/scope-input.js";
import { oneToOneHuman } from "../memory/scopes.js";
import { usedTaught } from "../memory/turn-recalls.js";
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
import { displayName, getApproval, isHumanMember, rowToApproval } from "./store.js";

export const SHARE_TOOL = "share_answer";
const MAX_TEXT = 8000;
const MAX_TEACHERS = 3;
const POSTED = "Posted.";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const citationsOf = (meta: unknown): Citation[] =>
  (isObject(meta) && Array.isArray(meta.citations) ? meta.citations : []) as Citation[];

/** Agent sources without an origin chat: what people taught the agent on its Knowledge tab. */
const taughtSources = (meta: unknown): Citation[] =>
  citationsOf(meta).filter((c) => c.space === "agent" && c.chat_id === undefined);

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
  // Runs at request time and again right before posting: policy and people are checked both times.
  async validate(args, ctx) {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text.trim()) throw new ArgsError("The answer is empty.");
    if (text.length > MAX_TEXT) throw new ArgsError("The answer is too long.");
    const [agent] = await ctx.db.query<{ share: string }>(
      "select share_private_in_chats as share from sa.agents where id = $1",
      [ctx.agentId],
    );
    if (agent?.share !== "ask" && agent?.share !== "always") {
      throw new ArgsError("Sharing taught knowledge is off for this agent.");
    }
    if (!(await isHumanMember(ctx.db, ctx.chatId, ctx.approverUserId))) {
      throw new ArgsError("The approver is not in this chat.");
    }
    if (ctx.requesterUserId && !(await isHumanMember(ctx.db, ctx.chatId, ctx.requesterUserId))) {
      throw new ArgsError("The person who asked is no longer in this chat.");
    }
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
      // Every source the post will carry; nothing else of the draft's meta is posted.
      sources: citationsOf(args.meta).slice(0, 8),
      leaves_chat: false,
    };
  },
  async execute(args, ctx) {
    const a = ctx.approval;
    if (!ctx.agentHost.postAs) throw new ExecError("The agent cannot post here.");
    // Only what the approver saw leaves: the text and the preview's sources (no trace, no draft meta).
    const sources = a.preview.sources ?? [];
    const meta: TextMeta = {
      ...(sources.length > 0 ? { citations: sources } : {}),
      approved_by: ctx.approverName.slice(0, 80),
    };
    const id = await ctx.agentHost.postAs(a.agent_id, a.chat_id, String(args.text), {
      replyTo: a.reply_to,
      meta,
    });
    if (!id) throw new ExecError("The agent can no longer post in this chat.");
    return POSTED;
  },
  async onDenied(a, ctx) {
    const declined = () =>
      a.status === "denied"
        ? statusLine(a, `Declined by ${a.approver_name} · ${a.tool}`)
        : undefined;
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
    if (!retry) {
      await declined();
      return;
    }
    retry
      .then((ran) => (ran ? undefined : declined()))
      .catch((e) => {
        approvalDeps().log("share retry failed", { id: a.id, error: (e as Error).name });
        return declined();
      });
  },
};

/**
 * The executor posts no stamps (an approved answer is its own post), so the other outcomes get
 * their status line from here; a preview that will never post loses its text and meta.
 */
const watchers = new Map<string, () => void>();

function unwatch(id: string): void {
  watchers.get(id)?.();
  watchers.delete(id);
}

async function statusLine(a: Approval, text: string): Promise<void> {
  const d = approvalDeps();
  if (!d.agentHost.postAs) return;
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

/** Keeps only the question (the retry's prompt): the held text, its meta and sources are gone. */
async function scrub(db: Db, id: string): Promise<void> {
  await db.query(
    `update sa.approvals
        set args = jsonb_build_object('question', coalesce(args->'question', '""'::jsonb)),
            preview = jsonb_set(preview - 'sources', '{fields}', '[]'::jsonb)
      where id = $1 and status in ('denied', 'expired', 'canceled', 'failed')`,
    [id],
  );
}

async function settled(a: Approval): Promise<void> {
  const d = approvalDeps();
  if (["denied", "expired", "canceled", "failed"].includes(a.status)) {
    try {
      await scrub(d.db, a.id);
    } catch (e) {
      d.log("share scrub failed", { id: a.id, error: (e as Error).name });
    }
  }
  if (a.status === "expired") {
    const ttl = formatTtl(a.expires_at - a.created_at);
    await statusLine(a, `Expired after ${ttl} without a decision · ${a.tool}`);
  } else if (a.status === "canceled") {
    const who = a.decided_by ? await displayName(d.db, a.decided_by).catch(() => "") : "";
    await statusLine(a, `Canceled by ${who || "the requester"} · ${a.tool}`);
  } else if (a.status === "failed") {
    await statusLine(a, `Approved by ${a.approver_name} · ${a.tool} · ${a.result ?? "failed"}`);
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
    void settled(e.approval).catch(() => {});
  });
  watchers.set(a.id, off);
}

/**
 * After a restart: follows the previews still pending, and gives the answers that failed while
 * the bridge was down (approved, never posted; their text is still there) their status line.
 */
export async function watchPendingShares(db: Db): Promise<void> {
  const rows = await db.query<{ id: string; approver_user_id: string }>(
    "select id, approver_user_id from sa.approvals where tool = $1 and status = 'pending'",
    [SHARE_TOOL],
  );
  for (const r of rows) watchShare(r);
  const failed = await db.query<{ id: string }>(
    `select id from sa.approvals where tool = $1 and status = 'failed' and args->>'text' is not null
        and decided_at > now() - interval '1 day'`,
    [SHARE_TOOL],
  );
  for (const r of failed) {
    const row = await getApproval(db, r.id);
    if (row) await settled(rowToApproval(row, false));
  }
}

export function stopShareWatchers(): void {
  for (const id of [...watchers.keys()]) unwatch(id);
}

const POST: ReplyDecision = { action: "post" };

/**
 * The D-9 `ask` gate fires on access: a turn in a shared chat that recalled taught knowledge
 * (`agent:<self>`, no origin chat) is held behind a share approval. Every failure past that point
 * throws, so the central fail-closed path posts FAIL_CLOSED_NOTICE and the turn ends as failed.
 */
export async function beforeReply(ctx: TurnContext, draft: ReplyDraft): Promise<ReplyDecision> {
  if (!usedTaught(ctx.turnId, ctx.agentId)) return POST;
  const { db } = approvalDeps();
  const inp = await loadScopeInput(db, ctx.agentId, ctx.chatId, {
    noTaught: ctx.noTaught,
    requesterUserId: ctx.requesterUserId,
  });
  if (!inp) throw new Error("share gate: agent or chat is gone");
  if (oneToOneHuman(inp.agent, inp.chat) !== null) return POST;
  if (inp.agent.share === "always") return POST;
  // `never` (or a policy change during the turn): this answer must not be shared at all.
  if (inp.agent.share !== "ask") throw new Error("share gate: sharing is off");
  const res = await requestApproval({
    agentId: ctx.agentId,
    chatId: ctx.chatId,
    replyTo: ctx.replyTo,
    turnId: ctx.turnId,
    requesterUserId: ctx.requesterUserId,
    kind: "share",
    tool: SHARE_TOOL,
    // Only the sources the preview shows are kept; the trace and the rest of the draft stay out.
    args: {
      text: draft.text,
      meta: draft.meta.citations ? { citations: draft.meta.citations } : {},
      question: ctx.prompt,
    },
  });
  if (res.status !== "pending") {
    throw new Error(`share gate: ${res.status === "error" ? res.error : res.status}`);
  }
  const a = res.approval;
  watchShare(a);
  const teachers = teacherNames(taughtSources(draft.meta));
  return {
    action: "hold",
    notice: `${ctx.agentName} prepared an answer that uses what ${teachers} taught it. Waiting for ${a.approver_name} to approve.`,
    meta: { held: a.id },
  };
}
