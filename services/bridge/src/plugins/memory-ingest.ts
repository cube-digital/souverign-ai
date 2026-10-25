import { addTurnHooks } from "../agents/turn-hooks.js";
import { memory } from "../memory/client.js";
import { ingestStored } from "../memory/ingest.js";
import type { BridgePlugin } from "../plugin-api.js";

/** Ingests stored chat messages and posted files into the chat's memory space. */
export const plugin: BridgePlugin = {
  name: "memory-ingest",
  async init(ctx) {
    addTurnHooks({
      name: "memory-ingest",
      onStored: (m) => ingestStored(m, { db: ctx.db, memory: memory(), log: ctx.log }),
    });
  },
};
