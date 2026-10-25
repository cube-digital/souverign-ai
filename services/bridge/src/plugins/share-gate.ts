import { addTurnHooks, SHARE_GATE_HOOK } from "../agents/turn-hooks.js";
import { registerGatedTool } from "../approvals/service.js";
import {
  beforeReply,
  SHARE_TOOL,
  shareExecutor,
  stopShareWatchers,
  watchPendingShares,
} from "../approvals/share-gate.js";
import type { BridgePlugin } from "../plugin-api.js";

/** The D-9 `ask` gate: answers that used taught knowledge wait for a share approval. */
export const plugin: BridgePlugin = {
  name: "share-gate",
  async init(ctx) {
    registerGatedTool(SHARE_TOOL, { executor: shareExecutor });
    addTurnHooks({ name: SHARE_GATE_HOOK, beforeReply });
    try {
      await watchPendingShares(ctx.db);
    } catch (e) {
      ctx.log("share gate watch failed", { error: (e as Error).name });
    }
  },
  stop() {
    stopShareWatchers();
  },
};
