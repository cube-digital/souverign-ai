import type { BridgeHooks } from "../agents/api.js";
import type { BridgePlugin, Log } from "../plugin-api.js";
import { startAlertWatch } from "../proactive/alert-watch.js";
import { makeCatchup } from "../proactive/catchup.js";
import { registerProactiveRoutes } from "../proactive/routes.js";
import { startRoutines } from "../proactive/routines.js";

let catchup: ReturnType<typeof makeCatchup> | undefined;
const stops: Array<() => void> = [];
let stopped = false;

/** Alert watch, daily catch-up, routines and Pause all. Proactive turns queue below human ones in the host. */
export const plugin: BridgePlugin = {
  name: "20-proactive",
  routes(app, deps) {
    catchup = makeCatchup(deps);
    registerProactiveRoutes(app, deps, catchup);
  },
  hooks: {
    onAgentDm: async (userId, agentId, chatId, created) => {
      await catchup?.onAgentDm(userId, agentId, chatId, created);
    },
  } satisfies BridgeHooks,
  start(ctx) {
    stopped = false;
    if (!catchup) catchup = makeCatchup(ctx);
    const fail = (log: Log) => (e: unknown) =>
      log("proactive start failed", { error: (e as Error).message });
    startAlertWatch(ctx)
      .then((w) => (stopped ? w.stop() : stops.push(w.stop)))
      .catch(fail(ctx.log));
    stops.push(startRoutines(ctx).stop);
  },
  stop() {
    stopped = true;
    for (const s of stops.splice(0)) s();
  },
};
