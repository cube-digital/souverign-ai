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
import { livekitAvailable, livekitUrl } from "./livekit-health.js";
import {
  CallError,
  callRow,
  createCall,
  endCall,
  failNotetaker,
  getCallInfo,
  inviteNotetaker,
  isParticipant,
  latestNotes,
  latestNotetaker,
  markJoined,
  markLeft,
  participantsInCall,
  segmentsOf,
  setAnchor,
  setConsent,
  stopNotetaker,
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
      if (r.ended) log("call ended", { call: callId });
      await life.emitUpdated(callId);
    },
    async afterLeave(callId) {
      if ((await participantsInCall(db, callId)).length > 0) return;
      life.cancelGrace(callId);
      const t = setTimeout(() => {
        timers.delete(callId);
        life
          .end(callId)
          .catch((e) => log("call end failed", { call: callId, error: (e as Error).message }));
      }, graceMs());
      t.unref?.();
      timers.set(callId, t);
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

  /** Session + call + chat membership; replies and returns null on refusal. */
  const open = async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return null;
    const id = (req.params as { id: string }).id;
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
  const info = async (callId: string): Promise<CallInfo> => {
    const i = await getCallInfo(db, callId);
    if (!i) throw new CallError(404, "not_found");
    return i;
  };

  app.post("/api/chats/:id/calls", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const chatId = (req.params as { id: string }).id;
    if (!(await isHumanMember(db, chatId, userId))) {
      return reply.code(403).send({ error: "forbidden" });
    }
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
    const c = await openParticipant(req, reply);
    if (!c) return;
    const body = NotetakerInvite.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    try {
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
        await hooks.startNotetaker(c.call.id, id, body.data.media_key);
      } catch (e) {
        await failNotetaker(db, id);
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
    const c = await openParticipant(req, reply);
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
    return { segments: nt ? await segmentsOf(db, nt.id, Math.round(c.call.started_ms)) : [] };
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
