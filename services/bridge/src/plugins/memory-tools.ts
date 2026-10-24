import { addTurnHooks } from "../agents/turn-hooks.js";
import { toCitations } from "../memory/citations.js";
import { registerMemoryTools } from "../memory/tools.js";
import { clearRecalls, recallsFor } from "../memory/turn-recalls.js";
import type { BridgePlugin } from "../plugin-api.js";

/** memory_recall / memory_remember, and the citations on replies that used them. */
export const plugin: BridgePlugin = {
  name: "memory-tools",
  async init({ db }) {
    registerMemoryTools();
    addTurnHooks({
      name: "memory-tools",
      async beforeReply(ctx, draft) {
        const recalls = recallsFor(ctx.turnId);
        if (recalls.length === 0) return { action: "post" };
        return { action: "post", meta: { citations: await toCitations(db, recalls, draft.text) } };
      },
      onTurnEnd(ctx) {
        clearRecalls(ctx.turnId);
      },
    });
  },
};
