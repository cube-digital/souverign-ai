import type { ServerEvent } from "@sa/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Authenticate } from "../plugin-api.js";

/** The web reconnects after 45 s without bytes; a comment every 15 s keeps the stream alive. */
export const PING_MS = 15_000;

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
    const write = (s: string) => {
      if (!res.writableEnded) res.write(s);
    };
    write(`data: ${JSON.stringify({ type: "hello", user_id: userId })}\n\n`);
    const unsubscribe = subscribe(userId, (e) => write(`data: ${JSON.stringify(e)}\n\n`));
    const timer = setInterval(() => {
      write(": ping\n\n");
      if (!alive) return;
      alive(req)
        .then((ok) => {
          if (!ok) end();
        })
        .catch(() => end());
    }, PING_MS);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      unsubscribe();
      open.delete(end);
      if (!res.writableEnded) res.end();
    };
    open.add(end);
    res.on("close", end);
  });
}
