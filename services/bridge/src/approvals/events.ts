import type { ServerEvent } from "@sa/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Authenticate } from "../plugin-api.js";

/** The web reconnects after 45 s without bytes; a comment every 15 s keeps the stream alive. */
export const PING_MS = 15_000;
/** Open streams per user; a new one ends the oldest. */
export const MAX_STREAMS_PER_USER = 3;
/** A stream whose client stopped reading is ended once this much is buffered; it reconnects. */
const MAX_BUFFERED = 1024 * 1024;

type Send = (e: ServerEvent) => void;
const subscribers = new Map<string, Set<Send>>();

/** Receives every event published to `userId` until the returned function is called. */
export function subscribe(userId: string, send: Send): () => void {
  const set = subscribers.get(userId) ?? new Set<Send>();
  set.add(send);
  subscribers.set(userId, set);
  return () => {
    set.delete(send);
    if (set.size === 0 && subscribers.get(userId) === set) subscribers.delete(userId);
  };
}

/** Sends `e` to every open stream of the given users (each user once). */
export function publish(userIds: string[], e: ServerEvent): void {
  for (const u of new Set(userIds)) {
    for (const send of subscribers.get(u) ?? []) {
      try {
        send(e);
      } catch {
        // a broken stream is cleaned up by its close handler
      }
    }
  }
}

/**
 * `GET /api/events`: the caller's own event stream (Bearer session).
 * `alive` is re-checked on every ping, so a stream ends when its session ends.
 */
export function registerEventsRoute(
  app: FastifyInstance,
  authenticate: Authenticate,
  alive?: (req: FastifyRequest) => Promise<boolean>,
): void {
  const open = new Set<() => void>();
  const byUser = new Map<string, Array<() => void>>();
  app.addHook("preClose", (done) => {
    for (const end of [...open]) end();
    done();
  });
  app.get("/api/events", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    let ended = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      unsubscribe();
      open.delete(end);
      const rest = (byUser.get(userId) ?? []).filter((f) => f !== end);
      if (rest.length) byUser.set(userId, rest);
      else byUser.delete(userId);
      if (!res.writableEnded) res.end();
    };
    const write = (s: string) => {
      if (ended || res.writableEnded) return;
      res.write(s);
      if (res.writableLength > MAX_BUFFERED) end();
    };
    open.add(end);
    byUser.set(userId, [...(byUser.get(userId) ?? []), end]);
    while ((byUser.get(userId)?.length ?? 0) > MAX_STREAMS_PER_USER) byUser.get(userId)?.[0]?.();
    write(`data: ${JSON.stringify({ type: "hello", user_id: userId })}\n\n`);
    unsubscribe = subscribe(userId, (e) => write(`data: ${JSON.stringify(e)}\n\n`));
    timer = setInterval(() => {
      write(": ping\n\n");
      if (!alive) return;
      alive(req)
        .then((ok) => {
          if (!ok) end();
        })
        .catch(() => end());
    }, PING_MS);
    res.on("close", end);
  });
}
