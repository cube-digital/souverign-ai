import { randomBytes } from "node:crypto";
import type { Approval, ApprovalDecision, ApprovalPreview, ApprovalPublic } from "@sa/protocol";
import type { AgentHostApi } from "../agents/api.js";
import type { Db } from "../db.js";
import type { Log } from "../plugin-api.js";
import { publish } from "./events.js";
import {
  type ApprovalRow,
  cancelPending,
  claimDecision,
  displayName,
  expireDue,
  failInterrupted,
  finish,
  getApproval,
  hasGrant,
  humanMembers,
  insertApproval,
  insertAutoApproved,
  insertGrant,
  type NewApproval,
  rowToApproval,
} from "./store.js";

export const DEFAULT_APPROVAL_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_PENDING_PER_CHAT = 5;
const SWEEP_MS = 5000;
const RESULT_MAX = 300;
const ERROR_MAX = 120;
const GONE = "This action is no longer available.";
const NO_REQUESTER = "No one asked for this, so I can't request approval. Ask a person to tag me.";
const NO_APPROVER = "No one can approve this here.";

export type ValidateCtx = {
  db: Db;
  agentId: string;
  chatId: string;
  approverUserId: string;
  requesterUserId: string | null;
  opsSimUrl: string;
};
export type ExecCtx = {
  db: Db;
  agentHost: AgentHostApi;
  opsSimUrl: string;
  approval: Approval;
  approverName: string;
};
export type Executor = {
  editable: readonly string[];
  alwaysAllowed: boolean;
  /** throw ArgsError with a short message the model can act on */
  validate(args: Record<string, unknown>, ctx: ValidateCtx): Promise<Record<string, unknown>>;
  preview(
    args: Record<string, unknown>,
    info: { agentName: string; chatTitle: string },
  ): ApprovalPreview;
  /** returns the result summary (≤ 300 chars); throwing marks the approval failed */
  execute(args: Record<string, unknown>, ctx: ExecCtx): Promise<string>;
  /** tool approvals get a stamp in the thread; share_answer posts the answer itself */
  stamp: boolean;
  onDenied?(approval: Approval, ctx: ExecCtx): Promise<void>;
};
export class ArgsError extends Error {}
export type GateRequest = {
  agentId: string;
  chatId: string;
  replyTo: string | null;
  turnId: string | null;
  requesterUserId: string | null;
  kind: "tool" | "share";
  tool: string;
  args: Record<string, unknown>;
  /** overrides the tool's defaultTtlMs */
  ttlMs?: number;
};
export type ApproverRule =
  | "owner_or_requester"
  | ((req: GateRequest, db: Db) => Promise<string | null>);
export type GatedToolSpec = {
  executor: Executor;
  approverRule?: ApproverRule;
  defaultTtlMs?: number;
};
export type GateResult =
  | { status: "pending" | "executed" | "failed"; approval: Approval }
  | {
      status: "error";
      error: "no_approver" | "too_many_pending" | "invalid_args" | "unknown_tool";
      message: string;
    };
export type DecideResult =
  | { ok: true; approval: Approval }
  | {
      ok: false;
      code: "not_found" | "expired" | "already_decided" | "invalid_args";
      approval?: Approval;
    };
export type CancelResult =
  | { ok: true; approval: Approval }
  | { ok: false; code: "not_found" | "already_decided" };

type Deps = { db: Db; agentHost: AgentHostApi; opsSimUrl: string; log: Log };

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const registry = new Map<string, GatedToolSpec>();
/** Lifetime in which each name was registered; initApprovals starts a new one. */
const registeredIn = new Map<string, number>();
let lifetime = 0;
const byTurn = new Map<string, string[]>();
let deps: Deps | null = null;

export function registerGatedTool(name: string, spec: GatedToolSpec): void {
  if (!TOOL_NAME.test(name)) throw new Error(`invalid gated tool name: ${name}`);
  // A name registers once per bridge lifetime; a re-initialised bridge (tests) may register it again.
  if (registeredIn.get(name) === lifetime) {
    throw new Error(`gated tool already registered: ${name}`);
  }
  registry.set(name, spec);
  registeredIn.set(name, lifetime);
}

export function gatedTool(name: string): GatedToolSpec | undefined {
  return registry.get(name);
}

/** The deps given to initApprovals; questions.ts shares them. */
export function approvalDeps(): Deps {
  if (!deps) throw new Error("approvals are not initialised");
  return deps;
}

export function initApprovals(d: Deps): void {
  deps = d;
  lifetime++;
  failInterrupted(d.db)
    .then((rows) => {
      for (const r of rows) void announceNow(toApproval(r));
      if (rows.length) d.log("approvals interrupted", { count: rows.length });
    })
    .catch((e) => d.log("approvals init failed", { error: (e as Error).message }));
}

export function ttlFromEnv(): number {
  const n = Number(process.env.SA_APPROVAL_TTL_MS || DEFAULT_APPROVAL_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_APPROVAL_TTL_MS;
}

const json = (v: unknown): Record<string, unknown> =>
  (typeof v === "string" ? JSON.parse(v) : v) as Record<string, unknown>;

const toApproval = (r: ApprovalRow): Approval =>
  rowToApproval(r, registry.get(r.tool)?.executor.alwaysAllowed ?? false);

export function toPublic(a: Approval): ApprovalPublic {
  return {
    id: a.id,
    chat_id: a.chat_id,
    agent_name: a.agent_name,
    tool: a.tool,
    status: a.status,
    approver_name: a.approver_name,
    requester_user_id: a.requester_user_id,
  };
}

/** The full approval goes only to the approver; other active humans of the chat get the public shadow. */
async function announceNow(a: Approval): Promise<void> {
  publish([a.approver_user_id], { type: "approval", approval: a });
  const d = approvalDeps();
  try {
    const users = await humanMembers(d.db, a.chat_id);
    publish(
      users.filter((u) => u !== a.approver_user_id),
      { type: "approval_public", approval: toPublic(a) },
    );
  } catch (e) {
    d.log("approval publish failed", { id: a.id, error: (e as Error).message });
  }
}

async function stamp(a: Approval, text: string): Promise<void> {
  const d = approvalDeps();
  if (!d.agentHost.postAs) return;
  try {
    await d.agentHost.postAs(a.agent_id, a.chat_id, text, {
      replyTo: a.reply_to,
      meta: { approval: { id: a.id, status: a.status } },
    });
  } catch (e) {
    d.log("approval stamp failed", { id: a.id, error: (e as Error).message });
  }
}

const execCtx = (a: Approval): ExecCtx => {
  const d = approvalDeps();
  return {
    db: d.db,
    agentHost: d.agentHost,
    opsSimUrl: d.opsSimUrl,
    approval: a,
    approverName: a.approver_name,
  };
};

async function resolveApprover(req: GateRequest, spec: GatedToolSpec): Promise<string | null> {
  const d = approvalDeps();
  const rule = spec.approverRule ?? "owner_or_requester";
  if (typeof rule === "function") return rule(req, d.db);
  const [agent] = await d.db.query<{ scope: string; owner_user_id: string | null }>(
    "select scope, owner_user_id from sa.agents where id = $1",
    [req.agentId],
  );
  if (!agent) return null;
  return agent.scope === "personal" ? agent.owner_user_id : req.requesterUserId;
}

/** Runs an approved row once and records executed | failed; posts the stamp. */
async function run(
  row: ApprovalRow,
  spec: GatedToolSpec | undefined,
  who: string,
): Promise<Approval> {
  const d = approvalDeps();
  const claimed = toApproval(row);
  let status: "executed" | "failed";
  let result: string;
  if (!spec) {
    status = "failed";
    result = GONE;
  } else {
    try {
      result = (await spec.executor.execute(claimed.args, execCtx(claimed))).slice(0, RESULT_MAX);
      status = "executed";
    } catch (e) {
      status = "failed";
      result = `failed: ${(e as Error).message.slice(0, ERROR_MAX)}`;
    }
  }
  const done = await finish(d.db, row.id, status, result);
  const a = done ? toApproval(done) : claimed;
  d.log("approval finished", { id: a.id, tool: a.tool, status: a.status });
  await announceNow(a);
  if (spec?.executor.stamp !== false) {
    await stamp(a, result ? `${who} · ${a.tool} · ${result}` : `${who} · ${a.tool}`);
  }
  return a;
}

export async function requestApproval(req: GateRequest): Promise<GateResult> {
  const d = approvalDeps();
  const spec = registry.get(req.tool);
  if (!spec) {
    return { status: "error", error: "unknown_tool", message: `Unknown tool: ${req.tool}.` };
  }
  const approver = await resolveApprover(req, spec);
  if (!approver) {
    const message =
      (spec.approverRule ?? "owner_or_requester") === "owner_or_requester" && !req.requesterUserId
        ? NO_REQUESTER
        : NO_APPROVER;
    return { status: "error", error: "no_approver", message };
  }
  const [info] = await d.db.query<{ agent_name: string; chat_title: string }>(
    `select a.name as agent_name, c.title as chat_title
     from sa.agents a, sa.chats c where a.id = $1 and c.id = $2`,
    [req.agentId, req.chatId],
  );
  if (!info) return { status: "error", error: "invalid_args", message: "Unknown agent or chat." };
  let args: Record<string, unknown>;
  try {
    args = await spec.executor.validate(req.args, {
      db: d.db,
      agentId: req.agentId,
      chatId: req.chatId,
      approverUserId: approver,
      requesterUserId: req.requesterUserId,
      opsSimUrl: d.opsSimUrl,
    });
  } catch (e) {
    if (e instanceof ArgsError) {
      return { status: "error", error: "invalid_args", message: e.message };
    }
    throw e;
  }
  const preview = spec.executor.preview(args, {
    agentName: info.agent_name,
    chatTitle: info.chat_title,
  });
  const row: NewApproval = {
    id: randomBytes(10).toString("hex"),
    agentId: req.agentId,
    chatId: req.chatId,
    replyTo: req.replyTo,
    turnId: req.turnId,
    kind: req.kind,
    tool: req.tool,
    args,
    preview,
    requesterUserId: req.requesterUserId,
    approverUserId: approver,
    ttlMs: req.ttlMs ?? spec.defaultTtlMs ?? ttlFromEnv(),
  };
  if (spec.executor.alwaysAllowed && (await hasGrant(d.db, approver, req.agentId, req.tool))) {
    const auto = await insertAutoApproved(d.db, row);
    remember(req.turnId, auto.id);
    d.log("approval auto", { id: auto.id, tool: auto.tool, agent: auto.agent_id });
    await announceNow(toApproval(auto));
    const a = await run(auto, spec, `Auto-approved for ${auto.approver_name}`);
    return { status: a.status === "executed" ? "executed" : "failed", approval: a };
  }
  const created = await insertApproval(d.db, row, MAX_PENDING_PER_CHAT);
  if (!created) {
    return {
      status: "error",
      error: "too_many_pending",
      message: `There are already ${MAX_PENDING_PER_CHAT} approvals waiting in this chat. Wait for a decision.`,
    };
  }
  remember(req.turnId, created.id);
  d.log("approval created", { id: created.id, tool: created.tool, agent: created.agent_id });
  const a = toApproval(created);
  await announceNow(a);
  return { status: "pending", approval: a };
}

function remember(turnId: string | null, id: string): void {
  if (!turnId) return;
  const ids = byTurn.get(turnId) ?? [];
  ids.push(id);
  byTurn.set(turnId, ids);
}

/** Approval ids created during a turn (the reply carries them in `meta.approvals`). */
export function approvalsInTurn(turnId: string): string[] {
  return [...(byTurn.get(turnId) ?? [])];
}

/** Drops the ids of a finished turn. */
export function forgetTurn(turnId: string): void {
  byTurn.delete(turnId);
}

/** Why a claim updated nothing: re-read the row. */
async function noClaim(id: string, userId: string): Promise<DecideResult> {
  const row = await getApproval(approvalDeps().db, id);
  if (!row || row.approver_user_id !== userId) return { ok: false, code: "not_found" };
  const a = toApproval(row);
  // still pending, so the claim failed on expires_at
  if (a.status === "pending") return { ok: false, code: "expired" };
  return { ok: false, code: "already_decided", approval: a };
}

export async function decide(
  id: string,
  userId: string,
  dec: ApprovalDecision,
): Promise<DecideResult> {
  const d = approvalDeps();
  const current = await getApproval(d.db, id);
  if (!current || current.approver_user_id !== userId) return { ok: false, code: "not_found" };
  if (current.status !== "pending") return noClaim(id, userId);
  const spec = registry.get(current.tool);
  const name = current.approver_name;

  if (dec.decision === "deny") {
    const row = await claimDecision(d.db, id, userId, "denied", json(current.args));
    if (!row) return noClaim(id, userId);
    const a = toApproval(row);
    d.log("approval denied", { id, tool: a.tool });
    await announceNow(a);
    if (spec?.executor.stamp !== false) await stamp(a, `Declined by ${name} · ${a.tool}`);
    await denied(spec, a);
    return { ok: true, approval: a };
  }

  let args = json(current.args);
  if (spec && dec.args) {
    const editable = new Set(spec.executor.editable);
    if (Object.keys(dec.args).some((k) => !editable.has(k))) {
      return { ok: false, code: "invalid_args" };
    }
    try {
      args = await spec.executor.validate(
        { ...args, ...dec.args },
        {
          db: d.db,
          agentId: current.agent_id,
          chatId: current.chat_id,
          approverUserId: current.approver_user_id,
          requesterUserId: current.requester_user_id,
          opsSimUrl: d.opsSimUrl,
        },
      );
    } catch (e) {
      if (e instanceof ArgsError) return { ok: false, code: "invalid_args" };
      throw e;
    }
  }
  const row = await claimDecision(d.db, id, userId, "approved", args);
  if (!row) return noClaim(id, userId);
  d.log("approval approved", { id, tool: row.tool });
  await announceNow(toApproval(row));
  if (dec.always && spec?.executor.alwaysAllowed) {
    await insertGrant(d.db, userId, row.agent_id, row.tool);
  }
  return { ok: true, approval: await run(row, spec, `Approved by ${name}`) };
}

async function denied(spec: GatedToolSpec | undefined, a: Approval): Promise<void> {
  if (!spec?.executor.onDenied) return;
  try {
    await spec.executor.onDenied(a, execCtx(a));
  } catch (e) {
    approvalDeps().log("approval onDenied failed", { id: a.id, error: (e as Error).message });
  }
}

export async function cancel(id: string, userId: string): Promise<CancelResult> {
  const d = approvalDeps();
  const row = await cancelPending(d.db, id, userId);
  if (!row) {
    const now = await getApproval(d.db, id);
    if (!now || now.requester_user_id !== userId) return { ok: false, code: "not_found" };
    return { ok: false, code: "already_decided" };
  }
  const a = toApproval(row);
  const spec = registry.get(a.tool);
  d.log("approval canceled", { id, tool: a.tool });
  await announceNow(a);
  if (spec?.executor.stamp !== false) {
    await stamp(a, `Canceled by ${await displayName(d.db, userId)} · ${a.tool}`);
  }
  if (userId === a.approver_user_id) await denied(spec, a);
  return { ok: true, approval: a };
}

/** `N min` under 2 h, else `N h`. */
export function formatTtl(ms: number): string {
  if (ms < 2 * 60 * 60 * 1000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

type QuestionSweep = () => Promise<void>;
let sweepQuestions: QuestionSweep | null = null;
/** questions.ts plugs its expiry into the sweeper. */
export function setQuestionSweep(fn: QuestionSweep): void {
  sweepQuestions = fn;
}

async function sweep(): Promise<void> {
  const d = deps;
  if (!d) return;
  const rows = await expireDue(d.db);
  for (const r of rows) {
    const a = toApproval(r);
    d.log("approval expired", { id: a.id, tool: a.tool });
    await announceNow(a);
    if (registry.get(a.tool)?.executor.stamp !== false) {
      await stamp(
        a,
        `Expired after ${formatTtl(a.expires_at - a.created_at)} without a decision · ${a.tool}`,
      );
    }
  }
  await sweepQuestions?.();
}

/** Expires due approvals and questions every `intervalMs`; returns the stop function. */
export function startSweeper(intervalMs: number = SWEEP_MS): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    sweep()
      .catch((e) => deps?.log("approval sweep failed", { error: (e as Error).message }))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
