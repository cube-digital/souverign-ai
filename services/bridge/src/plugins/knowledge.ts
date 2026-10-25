import { registerKnowledgeRoutes } from "../knowledge/routes.js";
import type { BridgePlugin } from "../plugin-api.js";

/** Teaching API: documents, lessons, corrections and the sharing setting of an agent. */
export const plugin: BridgePlugin = {
  name: "knowledge",
  routes(app, deps) {
    registerKnowledgeRoutes(app, deps);
  },
};
