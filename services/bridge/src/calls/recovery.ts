import type { Db } from "../db.js";
import type { Log } from "../plugin-api.js";
import type { Notetakers } from "./notetaker.js";
import type { Lifecycle } from "./routes.js";
import type { NotesScheduler } from "./scheduler.js";
import { failNotetaker, notetakerCall, participantsInCall } from "./store.js";

/**
 * After a restart: notetakers that are still `active` but have no worker in this process failed
 * with the old process (they get their final notes), and active calls nobody is in end.
 * Notetakers that run as `fake` are driven from outside and left alone.
 */
export async function recoverAfterRestart(o: {
  db: Db;
  notetakers: Notetakers;
  scheduler: NotesScheduler;
  life: Lifecycle;
  log: Log;
}): Promise<void> {
  const { db, notetakers, scheduler, life, log } = o;
  const zombies = await db.query<{ id: string }>(
    "select id from sa.call_notetakers where status = 'active' and worker <> 'fake'",
  );
  for (const z of zombies) {
    if (notetakers.has(z.id) || !(await failNotetaker(db, z.id))) continue;
    log("notetaker recovered after restart", { notetaker: z.id });
    const nt = await notetakerCall(db, z.id);
    if (nt) await life.emitUpdated(nt.call_id);
    await scheduler.final(z.id);
  }
  const calls = await db.query<{ id: string }>("select id from sa.calls where ended_at is null");
  for (const c of calls) {
    if ((await participantsInCall(db, c.id)).length === 0) {
      log("empty call ended after restart", { call: c.id });
      await life.end(c.id);
    }
  }
}
