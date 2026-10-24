import type { MessageBody, TextMeta, TurnTrigger } from "@sa/protocol";

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export type StoredMessage = {
  agentId: string;
  deviceId: string;
  chatId: string;
  id: string;
  seq: number;
  senderDevice: string;
  body: MessageBody;
  /** envelope ts (sender clock) */
  ts: number;
  /** bridge receipt time, epoch ms; memory uses it as source_ts */
  receivedAt: number;
  /** file bodies only: downloads and decrypts the blob */
  loadFile?: () => Promise<Uint8Array>;
};

export type TurnContext = {
  turnId: string;
  agentId: string;
  agentName: string;
  chatId: string;
  /** thread root the reply goes to; null for a top-level reply */
  replyTo: string | null;
  triggerMessageId: string | null;
  requesterUserId: string | null;
  trigger: TurnTrigger;
  prompt: string;
  /** retry after a denied private preview: recall must skip taught knowledge */
  noTaught: boolean;
};

export type ReplyDraft = { text: string; meta: TextMeta };
export type ReplyDecision =
  | { action: "post"; meta?: Partial<TextMeta> }
  | { action: "hold"; notice: string; meta?: Partial<TextMeta> };

export type TurnHooks = {
  name: string;
  onStored?(m: StoredMessage): Promise<void>;
  onTurnStart?(ctx: TurnContext): void;
  beforeReply?(ctx: TurnContext, draft: ReplyDraft): Promise<ReplyDecision>;
  onTurnEnd?(ctx: TurnContext): void;
};

export const FAIL_CLOSED_NOTICE = "I could not finish this answer safely. Please ask again.";

const hooks: TurnHooks[] = [];
const current = new Map<string, TurnContext>();

/** Registers hooks; a second registration with the same name replaces the first. */
export function addTurnHooks(h: TurnHooks): void {
  const i = hooks.findIndex((x) => x.name === h.name);
  if (i >= 0) hooks[i] = h;
  else hooks.push(h);
}

/** Tests only. */
export function clearTurnHooks(): void {
  hooks.length = 0;
  current.clear();
}

export function hasBeforeReplyHooks(): boolean {
  return hooks.some((h) => h.beforeReply);
}

/** The turn the agent is running now (one at a time per agent). */
export function currentTurn(agentId: string): TurnContext | undefined {
  return current.get(agentId);
}

/** Fire-and-forget: never blocks the message loop. */
export function runStored(m: StoredMessage, log: Log): void {
  for (const h of hooks) {
    if (!h.onStored) continue;
    h.onStored(m).catch((e) =>
      log("stored hook failed", { hook: h.name, error: (e as Error).message }),
    );
  }
}

export function beginTurn(ctx: TurnContext, log: Log): void {
  current.set(ctx.agentId, ctx);
  for (const h of hooks) {
    try {
      h.onTurnStart?.(ctx);
    } catch (e) {
      log("turn start hook failed", { hook: h.name, error: (e as Error).message });
    }
  }
}

export function endTurn(agentId: string, log: Log): void {
  const ctx = current.get(agentId);
  if (!ctx) return;
  current.delete(agentId);
  for (const h of hooks) {
    try {
      h.onTurnEnd?.(ctx);
    } catch (e) {
      log("turn end hook failed", { hook: h.name, error: (e as Error).message });
    }
  }
}

/**
 * Runs every beforeReply hook in registration order; later hooks see the meta of earlier ones.
 * The first hold wins. A hook that throws holds the reply (fail closed).
 */
export async function runBeforeReply(
  ctx: TurnContext,
  draft: ReplyDraft,
  log: Log,
): Promise<{ text: string; meta: TextMeta; held: boolean }> {
  let meta: TextMeta = { ...draft.meta };
  for (const h of hooks) {
    if (!h.beforeReply) continue;
    let d: ReplyDecision;
    try {
      d = await h.beforeReply(ctx, { text: draft.text, meta });
    } catch (e) {
      log("before reply hook failed", { hook: h.name, error: (e as Error).message });
      return { text: FAIL_CLOSED_NOTICE, meta, held: true };
    }
    meta = { ...meta, ...(d.meta ?? {}) };
    if (d.action === "hold") return { text: d.notice, meta, held: true };
  }
  return { text: draft.text, meta, held: false };
}
