import { registerInternalCallRoutes } from "../calls/internal-routes.js";
import { Notetakers, nodeSpawner } from "../calls/notetaker.js";
import {
  type CallHooks,
  type Lifecycle,
  makeLifecycle,
  registerCallRoutes,
} from "../calls/routes.js";
import { NotesScheduler } from "../calls/scheduler.js";
import { notetakerCall } from "../calls/store.js";
import { registerLivekitWebhook } from "../calls/webhook.js";
import type { BridgePlugin } from "../plugin-api.js";

let life: Lifecycle | undefined;
let notetakers: Notetakers | undefined;
let scheduler: NotesScheduler | undefined;

const hooks: CallHooks = {
  async startNotetaker(callId, notetakerId, mediaKey) {
    if (!notetakers) throw new Error("calls plugin is not initialised");
    await notetakers.start(callId, notetakerId, mediaKey);
  },
  notetakerEnded(notetakerId) {
    notetakers?.stopProcess(notetakerId);
    void scheduler?.final(notetakerId);
  },
};

const intervalMs = (): number => {
  const n = Number(process.env.SA_NOTES_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
};

/** Calls: store, LiveKit tokens, consent, notetaker worker, notes. */
export const plugin: BridgePlugin = {
  name: "calls",
  async init(ctx) {
    scheduler?.stop();
    notetakers?.killAll();
    scheduler = new NotesScheduler({
      db: ctx.db,
      agentHost: ctx.agentHost,
      intervalMs: intervalMs(),
      log: ctx.log,
    });
    notetakers = new Notetakers({
      db: ctx.db,
      spawner: nodeSpawner,
      log: ctx.log,
      onFinal: async (notetakerId) => {
        const nt = await notetakerCall(ctx.db, notetakerId);
        if (nt) await life?.emitUpdated(nt.call_id);
        await scheduler?.final(notetakerId);
      },
    });
    notetakers.cleanupOrphans();
  },
  routes(app, deps) {
    life?.clear();
    life = makeLifecycle(deps.db, hooks, deps.log);
    registerCallRoutes(app, deps, hooks, life);
    registerLivekitWebhook(app, deps, life);
    registerInternalCallRoutes(app, deps);
  },
  start() {
    scheduler?.start();
  },
  stop() {
    scheduler?.stop();
    notetakers?.killAll();
    life?.clear();
    life = undefined;
  },
};
