import {
  AnchorRequest,
  type CallInfo,
  type CallToken,
  ConsentRequest,
  NotetakerInvite,
} from "@sa/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { publish } from "../approvals/events.js";
import { displayName, humanMembers, isHumanMember } from "../approvals/store.js";
import type { Db } from "../db.js";
import type { Log, RouteDeps } from "../plugin-api.js";
import { LIMITS, Limiter } from "./limits.js";
import { closeRoom, kickFromRoom } from "./livekit-admin.js";
import { livekitAvailable, livekitUrl } from "./livekit-health.js";
import {
  CallError,
  callRow,
  createCall,
  endCall,
  failNotetaker,
  getCallInfo,
  inviteNotetaker,
  isInCall,
  isParticipant,
  joinedAtMs,
  latestNotes,
  latestNotetaker,
  markJoined,
  markLeft,
  participantsInCall,
  segmentsOf,
  setAnchor,
  setConsent,
  stopNotetaker,
  strandedParticipants,
} from "./store.js";
import { userToken } from "./tokens.js";

export type CallHooks = {
  /** Starts the worker for a freshly invited notetaker; throws `CallError` when it cannot. */
  startNotetaker(callId: string, notetakerId: string, mediaKey?: string): Promise<void>;
  /** The notetaker left `active` through stop or end: kill the worker, run the final summary. */
  notetakerEnded(notetakerId: string): void;
};

export type Lifecycle = {
  emitUpdated(callId: string): Promise<void>;
  /** Ends the call now (starter, owner, grace timer or call server). */
  end(callId: string): Promise<void>;
  /** Starts the last-leave grace timer when nobody is left in the call. */
  afterLeave(callId: string): Promise<void>;
  cancelGrace(callId: string): void;
  /** Removes people who are no longer chat members from their calls and the room. */
  reconcile(): Promise<void>;
  clear(): void;
};

export function makeLifecycle(db: Db, hooks: CallHooks, log: Log): Lifecycle {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const graceMs = () => {
    const n = Number(process.env.SA_CALL_GRACE_MS);
    return Number.isFinite(n) && n >= 0 && process.env.SA_CALL_GRACE_MS ? n : 30_000;
  };
  const life: Lifecycle = {
    async emitUpdated(callId) {
      const call = await getCallInfo(db, callId);
      if (!call) return;
      publish(await humanMembers(db, call.chat_id), { type: "call.updated", call });
    },
    async end(callId) {
      life.cancelGrace(callId);
      const r = await endCall(db, callId);
      if (r.notetakerId) hooks.notetakerEnded(r.notetakerId);
      if (r.ended) {
        log("call ended", { call: callId });
        await closeRoom(callId, log);
      }
      await life.emitUpdated(callId);
    },
    async afterLeave(callId) {
      if ((await participantsInCall(db, callId)).length > 0) return;
      life.cancelGrace(callId);
      const t = setTimeout(() => {
        timers.delete(callId);
        life
          .end(callId)
          .catch((e) => log("call end failed", { call: callId, error: (e as Error).name }));
      }, graceMs());
      t.unref?.();
      timers.set(callId, t);
    },
    async reconcile() {
      for (const r of await strandedParticipants(db)) {
        // Marked left only once the room confirms; a failed kick is tried again next sweep.
        if (!(await kickFromRoom(r.call_id, r.user_id, log))) continue;
        await markLeft(db, r.call_id, r.user_id);
        log("participant removed after leaving the chat", { call: r.call_id });
        await life.emitUpdated(r.call_id);
        await life.afterLeave(r.call_id);
      }
    },
    cancelGrace(callId) {
      const t = timers.get(callId);
      if (t) clearTimeout(t);
      timers.delete(callId);
    },
    clear() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
  return life;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NOTETAKER_COOLDOWN_MS = 10_000;

const fail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof CallError) return reply.code(e.status).send({ error: e.code });
  throw e;
};

export function registerCallRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  hooks: CallHooks,
  life: Lifecycle,
): void {
  const { db, authenticate, log } = deps;
  const limiter = new Limiter();
  const failedAt = new Map<string, number>();
  /** Per user and per call; replies 429 and returns false when either is over `max`. */
  const allow = async (
    reply: FastifyReply,
    bucket: string,
    userId: string,
    callOrChat: string,
    max: number,
    callMax = max * 4,
  ): Promise<boolean> => {
    if (
      limiter.hit(`${bucket}:u:${userId}`, max) &&
      limiter.hit(`${bucket}:c:${callOrChat}`, callMax)
    ) {
      return true;
    }
    await reply.code(429).send({ error: "rate_limited" });
    return false;
  };

  /** Session + call + chat membership; replies and returns null on refusal. */
  const open = async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return null;
    const id = (req.params as { id: string }).id;
    if (!SAFE_ID.test(id)) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    const call = await callRow(db, id);
    if (!call) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    if (!(await isHumanMember(db, call.chat_id, userId))) {
      await reply.code(403).send({ error: "forbidden" });
      return null;
    }
    return { userId, call };
  };
  /** Like `open`, and the caller must have a participant row. */
  const openParticipant = async (req: FastifyRequest, reply: FastifyReply) => {
    const c = await open(req, reply);
    if (!c) return null;
    if (!(await isParticipant(db, c.call.id, c.userId))) {
      await reply.code(403).send({ error: "not_in_call" });
      return null;
    }
    return c;
  };
  /** Like `openParticipant`, and the caller must be in the call right now. */
  const openInCall = async (req: FastifyRequest, reply: FastifyReply) => {
    const c = await openParticipant(req, reply);
    if (!c) return null;
    if (!(await isInCall(db, c.call.id, c.userId))) {
      await reply.code(403).send({ error: "not_in_call" });
      return null;
    }
    return c;
  };
  const info = async (callId: string): Promise<CallInfo> => {
    const i = await getCallInfo(db, callId);
    if (!i) throw new CallError(404, "not_found");
    return i;
  };

  app.post("/api/chats/:id/calls", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const chatId = (req.params as { id: string }).id;
    if (!SAFE_ID.test(chatId)) return reply.code(404).send({ error: "not_found" });
    if (!(await isHumanMember(db, chatId, userId))) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (!(await allow(reply, "start", userId, chatId, LIMITS.start))) return;
    try {
      const r = await createCall(db, chatId, userId, process.env.SA_CALL_E2EE === "1");
      if (r.created) log("call started", { call: r.id, chat: chatId });
      await life.emitUpdated(r.id);
      return reply.code(r.created ? 201 : 200).send({ call: await info(r.id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get("/api/calls/:id", async (req, reply) => {
    const c = await open(req, reply);
    if (!c) return;
    return info(c.call.id);
  });

  app.post("/api/calls/:id/anchor", async (req, reply) => {
    const c = await open(req, reply);
    if (!c) return;
    if (c.call.started_by !== c.userId) return reply.code(403).send({ error: "forbidden" });
    const body = AnchorRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    if (!(await setAnchor(db, c.call.id, body.data.message_id))) {
      return reply.code(409).send({ error: "anchor_set" });
    }
    await life.emitUpdated(c.call.id);
    return { ok: true };
  });

  app.post("/api/calls/:id/token", async (req, reply) => {
    const c = await open(req, reply);
    if (!c) return;
    if (c.call.ended_ms !== null) return reply.code(409).send({ error: "call_ended" });
    if (!(await allow(reply, "presence", c.userId, c.call.id, LIMITS.presence))) {
      return;
    }
    await markJoined(db, c.call.id, c.userId);
    life.cancelGrace(c.call.id);
    await life.emitUpdated(c.call.id);
    const identity = `user:${c.userId}`;
    const url = process.env.LIVEKIT_PUBLIC_URL ?? livekitUrl();
    let token = "";
    let available = await livekitAvailable();
    if (available) {
      try {
        token = await userToken({
          callId: c.call.id,
          userId: c.userId,
          name: await displayName(db, c.userId),
        });
      } catch {
        available = false;
      }
    }
    const out: CallToken = { available, url, token, identity };
    return out;
  });

  app.post("/api/calls/:id/leave", async (req, reply) => {
    const c = await openParticipant(req, reply);
    if (!c) return;
    if (!(await allow(reply, "presence", c.userId, c.call.id, LIMITS.presence))) {
      return;
    }
    await markLeft(db, c.call.id, c.userId);
    await life.emitUpdated(c.call.id);
    await life.afterLeave(c.call.id);
    return { ok: true };
  });

  app.post("/api/calls/:id/end", async (req, reply) => {
    const c = await open(req, reply);
    if (!c) return;
    const [owner] = await db.query(
      `select 1 from sa.chat_members where chat_id = $1 and member_type = 'user'
         and member_id = $2 and role = 'owner' and removed_at is null`,
      [c.call.chat_id, c.userId],
    );
    if (c.call.started_by !== c.userId && !owner) {
      return reply.code(403).send({ error: "forbidden" });
    }
    await life.end(c.call.id);
    return { ok: true };
  });

  app.post("/api/calls/:id/notetaker", async (req, reply) => {
    const c = await openInCall(req, reply);
    if (!c) return;
    const body = NotetakerInvite.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    // The media key only matters when call audio is end-to-end encrypted.
    const mediaKey = c.call.e2ee ? body.data.media_key : undefined;
    if (mediaKey !== undefined && mediaKey.length > 64) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (!(await allow(reply, "invite", c.userId, c.call.id, LIMITS.invite))) return;
    if (Date.now() - (failedAt.get(c.call.id) ?? 0) < NOTETAKER_COOLDOWN_MS) {
      return reply.code(429).send({ error: "rate_limited" });
    }
    try {
      const [{ n } = { n: 0 }] = await db.query<{ n: number | string }>(
        "select count(*) as n from sa.call_notetakers where status = 'active'",
      );
      const max =
        Number(process.env.SA_NOTETAKER_MAX) > 0 ? Number(process.env.SA_NOTETAKER_MAX) : 4;
      if (Number(n) >= max) throw new CallError(429, "too_many_notetakers");
      if (c.call.ended_ms !== null) throw new CallError(409, "call_ended");
      const [scribe] = await db.query<{ id: string }>(
        `select a.id from sa.agents a
           join sa.chat_members m on m.member_type = 'agent' and m.member_id = a.id
            and m.chat_id = $1 and m.removed_at is null
          where a.scope = 'workspace' and a.roster_id = 'scribe' limit 1`,
        [c.call.chat_id],
      );
      if (!scribe) throw new CallError(409, "notetaker_not_in_chat");
      const id = await inviteNotetaker(db, c.call.id, scribe.id, c.userId);
      log("notetaker invited", { call: c.call.id, notetaker: id });
      try {
        await hooks.startNotetaker(c.call.id, id, mediaKey);
      } catch (e) {
        await failNotetaker(db, id);
        failedAt.set(c.call.id, Date.now());
        await life.emitUpdated(c.call.id);
        throw e;
      }
      await life.emitUpdated(c.call.id);
      return reply.code(201).send(await info(c.call.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/api/calls/:id/consent", async (req, reply) => {
    const c = await openParticipant(req, reply);
    if (!c) return;
    const body = ConsentRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const nt = await latestNotetaker(db, c.call.id);
    if (nt?.status !== "active") return reply.code(409).send({ error: "not_active" });
    if (nt.invited_by === c.userId) {
      return reply.code(409).send({ error: "inviter_always_consents" });
    }
    await setConsent(db, nt.id, c.userId, body.data.decision);
    await life.emitUpdated(c.call.id);
    return info(c.call.id);
  });

  app.post("/api/calls/:id/notetaker/stop", async (req, reply) => {
    const c = await openInCall(req, reply);
    if (!c) return;
    const nt = await latestNotetaker(db, c.call.id);
    if (!nt || !(await stopNotetaker(db, nt.id, c.userId))) {
      return reply.code(409).send({ error: "not_active" });
    }
    log("notetaker stopped", { call: c.call.id, notetaker: nt.id });
    hooks.notetakerEnded(nt.id);
    await life.emitUpdated(c.call.id);
    return info(c.call.id);
  });

  app.get("/api/calls/:id/segments", async (req, reply) => {
    const c = await openParticipant(req, reply);
    if (!c) return;
    const nt = await latestNotetaker(db, c.call.id);
    if (!nt) return { segments: [] };
    const start = Math.round(c.call.started_ms);
    if (nt.invited_by === c.userId) {
      return { segments: await segmentsOf(db, nt.id, start) };
    }
    // Others see the live lines only while they are in the call, and only from when they joined.
    if (nt.status !== "active" || !(await isInCall(db, c.call.id, c.userId))) {
      return reply.code(403).send({ error: "notes_private" });
    }
    const since = await joinedAtMs(db, c.call.id, c.userId);
    return { segments: await segmentsOf(db, nt.id, start, since ?? Date.now()) };
  });

  app.get("/api/calls/:id/notes", async (req, reply) => {
    const c = await open(req, reply);
    if (!c) return;
    const nt = await latestNotetaker(db, c.call.id);
    if (nt && nt.invited_by !== c.userId) return reply.code(403).send({ error: "notes_private" });
    const notes = nt ? await latestNotes(db, nt.id) : null;
    return reply.type("application/json").send(JSON.stringify(notes));
  });
}
