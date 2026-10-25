import { registerGatedTool } from "../approvals/service.js";
import { registerInternalCallRoutes } from "../calls/internal-routes.js";
import { registerNotesRoutes } from "../calls/notes-routes.js";
import { Notetakers, nodeSpawner } from "../calls/notetaker.js";
import {
  approverRule,
  callNotesExecutor,
  configurePublish,
  NOTES_TOOL,
  NOTES_TTL_MS,
  onFinalNotes,
  sweep,
} from "../calls/publish.js";
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
let stopSweep: (() => void) | undefined;
const SWEEP_MS = 60_000;

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
      onFinalNotes,
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
    configurePublish({ relayAdmin: ctx.relayAdmin });
    registerGatedTool(NOTES_TOOL, {
      executor: callNotesExecutor,
      approverRule,
      defaultTtlMs: NOTES_TTL_MS,
    });
    stopSweep?.();
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      sweep(Date.now())
        .catch((e) => ctx.log("call notes sweep failed", { error: (e as Error).message }))
        .finally(() => {
          busy = false;
        });
    }, SWEEP_MS);
    timer.unref?.();
    stopSweep = () => clearInterval(timer);
  },
  routes(app, deps) {
    life?.clear();
    life = makeLifecycle(deps.db, hooks, deps.log);
    registerCallRoutes(app, deps, hooks, life);
    registerLivekitWebhook(app, deps, life);
    registerInternalCallRoutes(app, deps);
    registerNotesRoutes(app, deps);
  },
  start() {
    scheduler?.start();
  },
  stop() {
    stopSweep?.();
    stopSweep = undefined;
    scheduler?.stop();
    notetakers?.killAll();
    life?.clear();
    life = undefined;
  },
};
