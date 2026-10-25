import type { TextMeta } from "@sa/protocol";
import { addTurnHooks, hasBeforeReplyHooks } from "../agents/turn-hooks.js";
import { registerAskUser } from "../approvals/questions.js";
import { registerApprovalRoutes } from "../approvals/routes.js";
import {
  approvalsInTurn,
  approvalsReady,
  forgetTurn,
  gatedTool,
  initApprovals,
  startSweeper,
} from "../approvals/service.js";
import type { BridgePlugin } from "../plugin-api.js";

const namesGatedTool = (trace: TextMeta["trace"]): boolean =>
  (trace ?? []).some((s) => s.kind === "tool" && gatedTool(s.name) !== undefined);

let stopSweeper: (() => void) | null = null;

/** Approvals state machine, `/api/events`, expiry sweeper and `ask_user` questions. */
export const plugin: BridgePlugin = {
  name: "approvals",
  async init(ctx) {
    initApprovals({ db: ctx.db, agentHost: ctx.agentHost, opsSimUrl: ctx.opsSimUrl, log: ctx.log });
    await approvalsReady();
    registerAskUser();
    // Registered before any other before-reply hook (plugins init in name order), so a later
    // hold or failure keeps `trace: undefined` in the accumulated meta.
    if (hasBeforeReplyHooks()) ctx.log("approvals hook is not the first before-reply hook");
    addTurnHooks({
      name: "approvals",
      beforeReply: async (turn, draft) => {
        const ids = approvalsInTurn(turn.turnId);
        const strip = ids.length > 0 || namesGatedTool(draft.meta.trace);
        const meta: Partial<TextMeta> = {
          ...(ids.length ? { approvals: ids.slice(0, 4) } : {}),
          // The trace holds the gated tools' args and results, which only the approver may see.
          ...(strip ? { trace: undefined } : {}),
        };
        return { action: "post", meta };
      },
      onTurnEnd: (turn) => forgetTurn(turn.turnId),
    });
  },
  routes(app, deps) {
    registerApprovalRoutes(app, deps);
  },
  start() {
    stopSweeper?.();
    stopSweeper = startSweeper();
  },
  stop() {
    stopSweeper?.();
    stopSweeper = null;
  },
};
