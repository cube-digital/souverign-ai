import type { FastifyInstance } from "fastify";
import { WebhookReceiver } from "livekit-server-sdk";
import { isHumanMember } from "../approvals/store.js";
import type { RouteDeps } from "../plugin-api.js";
import { closeRoom, kickFromRoom } from "./livekit-admin.js";
import type { Lifecycle } from "./routes.js";
import { callRow, markJoined, markLeft } from "./store.js";
import { API_KEY } from "./tokens.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** `POST /internal/livekit/webhook`: loopback only, signature-checked, keeps presence right. */
export function registerLivekitWebhook(
  app: FastifyInstance,
  deps: RouteDeps,
  life: Lifecycle,
): void {
  const { db, log } = deps;
  app.addContentTypeParser("application/webhook+json", { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );
  app.post("/internal/livekit/webhook", async (req, reply) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const secret = process.env.LIVEKIT_API_SECRET;
    const auth = req.headers.authorization;
    if (!secret || !auth || typeof req.body !== "string") {
      return reply.code(401).send({ error: "bad_signature" });
    }
    let event: Awaited<ReturnType<WebhookReceiver["receive"]>>;
    try {
      event = await new WebhookReceiver(API_KEY, secret).receive(req.body, auth);
    } catch {
      return reply.code(401).send({ error: "bad_signature" });
    }
    const callId = (event.room?.name ?? "").replace(/^call-/, "");
    const call = callId ? await callRow(db, callId) : null;
    if (!call) return reply.send({ ok: true });
    const identity = event.participant?.identity ?? "";
    const ended = call.ended_ms !== null;
    if (event.event === "participant_joined" && identity.startsWith("user:")) {
      const userId = identity.slice(5);
      // Presence on an ended call, or from someone who is not an active member, is ignored.
      if (ended) {
        await closeRoom(call.id, log);
        return reply.send({ ok: true });
      }
      if (!(await isHumanMember(db, call.chat_id, userId))) {
        await kickFromRoom(call.id, userId, log);
        return reply.send({ ok: true });
      }
      await markJoined(db, call.id, userId);
      life.cancelGrace(call.id);
      await life.emitUpdated(call.id);
    } else if (event.event === "participant_left" && identity.startsWith("user:")) {
      await markLeft(db, call.id, identity.slice(5));
      await life.emitUpdated(call.id);
      await life.afterLeave(call.id);
    } else if (event.event === "room_finished") {
      await life.end(call.id);
    }
    log("livekit webhook", { event: event.event, call: call.id });
    return reply.send({ ok: true });
  });
}
