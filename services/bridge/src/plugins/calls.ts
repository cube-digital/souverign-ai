import {
  type CallHooks,
  type Lifecycle,
  makeLifecycle,
  registerCallRoutes,
} from "../calls/routes.js";
import { registerLivekitWebhook } from "../calls/webhook.js";
import type { BridgePlugin } from "../plugin-api.js";

let life: Lifecycle | undefined;

const hooks: CallHooks = {
  startNotetaker: async () => {},
  notetakerEnded: () => {},
};

/** Calls: store, LiveKit tokens, consent, notes, webhook. */
export const plugin: BridgePlugin = {
  name: "calls",
  routes(app, deps) {
    life?.clear();
    life = makeLifecycle(deps.db, hooks, deps.log);
    registerCallRoutes(app, deps, hooks, life);
    registerLivekitWebhook(app, deps, life);
  },
  stop() {
    life?.clear();
    life = undefined;
  },
};
