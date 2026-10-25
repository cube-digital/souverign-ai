import { addTurnHooks } from "../agents/turn-hooks.js";
import { registerAskUser } from "../approvals/questions.js";
import { registerApprovalRoutes } from "../approvals/routes.js";
import { approvalsInTurn, forgetTurn, initApprovals, startSweeper } from "../approvals/service.js";
import type { BridgePlugin } from "../plugin-api.js";

let stopSweeper: (() => void) | null = null;

/** Approvals state machine, `/api/events`, expiry sweeper and `ask_user` questions. */
export const plugin: BridgePlugin = {
  name: "approvals",
  async init(ctx) {
    initApprovals({ db: ctx.db, agentHost: ctx.agentHost, opsSimUrl: ctx.opsSimUrl, log: ctx.log });
    registerAskUser();
    addTurnHooks({
      name: "approvals",
      beforeReply: async (ctx) => {
        const ids = approvalsInTurn(ctx.turnId);
        // The trace holds the gated tools' args, which only the approver may see.
        return ids.length
          ? { action: "post", meta: { approvals: ids.slice(0, 4), trace: undefined } }
          : { action: "post" };
      },
      onTurnEnd: (ctx) => forgetTurn(ctx.turnId),
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
