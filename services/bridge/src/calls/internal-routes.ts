import { timingSafeEqual } from "node:crypto";
import { SegmentIn, WorkerReport, type WorkerStateResponse } from "@sa/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { publish } from "../approvals/events.js";
import type { RouteDeps } from "../plugin-api.js";
import { consentedIdentities, getCallInfo, notetakerCall, participantsInCall } from "./store.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function sameToken(given: unknown, want: string): boolean {
  if (typeof given !== "string" || !want) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Worker-facing routes: loopback callers holding `MEETING_TOKEN` only. */
export function registerInternalCallRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, log } = deps;
  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const forwarded = Object.keys(req.headers).some((h) => h.startsWith("x-forwarded-"));
    if (
      !LOOPBACK.has(req.socket.remoteAddress ?? "") ||
      forwarded ||
      !sameToken(req.headers["x-internal-token"], process.env.MEETING_TOKEN ?? "")
    ) {
      await reply.code(403).send({ error: "forbidden" });
    }
  };
  const base = "/internal/calls/notetakers/:id";

  app.get(`${base}/state`, { onRequest: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!SAFE_ID.test(id)) return reply.code(404).send({ error: "not_found" });
    const nt = await notetakerCall(db, id);
    if (!nt) return reply.code(404).send({ error: "not_found" });
    const out: WorkerStateResponse = {
      status: nt.status as WorkerStateResponse["status"],
      consented: await consentedIdentities(db, id),
    };
    return out;
  });

  app.post(`${base}/segments`, { onRequest: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!SAFE_ID.test(id)) return reply.code(404).send({ error: "not_found" });
    const nt = await notetakerCall(db, id);
    if (!nt) return reply.code(404).send({ error: "not_found" });
    if (nt.status !== "active") return reply.code(409).send({ error: "not_active" });
    // Anything that is not a person (an agent identity) is refused before validation.
    const speaker = (req.body as { speaker?: unknown } | null)?.speaker;
    if (typeof speaker !== "string" || !speaker.startsWith("user:")) {
      return reply.code(403).send({ error: "not_consented" });
    }
    const body = SegmentIn.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const call = await getCallInfo(db, nt.call_id);
    if (!call) return reply.code(404).send({ error: "not_found" });
    const userId = body.data.speaker.slice("user:".length);
    // One statement checks consent, presence, membership and status again at insert time.
    const [row] = await db.query<{ id: number | string; name: string }>(
      `with s as (
         insert into sa.call_segments (notetaker_id, speaker_user_id, t0, t1, text, lang)
         select $1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0), $5, $6
          where exists (
            select 1 from sa.call_notetakers n
              join sa.calls c on c.id = n.call_id
              join sa.call_consents k on k.notetaker_id = n.id and k.user_id = $2 and k.decision = 'accepted'
              join sa.call_participants p on p.call_id = n.call_id and p.user_id = $2 and p.left_at is null
             where n.id = $1 and n.status = 'active'
               and exists (select 1 from sa.chat_members m where m.chat_id = c.chat_id
                 and m.member_type = 'user' and m.member_id = $2 and m.removed_at is null))
         returning id)
       select s.id, u.display_name as name from s, sa.users u where u.id = $2`,
      [id, userId, body.data.t0_ms, body.data.t1_ms, body.data.text, body.data.lang ?? null],
    );
    if (!row) return reply.code(403).send({ error: "not_consented" });
    if (row) {
      publish(await participantsInCall(db, nt.call_id), {
        type: "call.segment",
        call_id: nt.call_id,
        segment: {
          id: Number(row.id),
          speaker_user_id: userId,
          speaker_name: row.name,
          t_ms: Math.max(0, body.data.t0_ms - call.started_at),
          text: body.data.text,
        },
      });
    }
    log("call segment stored", { notetaker: id, chars: body.data.text.length });
    return reply.code(201).send({ ok: true });
  });

  app.post(`${base}/worker`, { onRequest: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!SAFE_ID.test(id)) return reply.code(404).send({ error: "not_found" });
    const nt = await notetakerCall(db, id);
    if (!nt) return reply.code(404).send({ error: "not_found" });
    const body = WorkerReport.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    // A worker that left on its own while active changes nothing: stop drives the status.
    if (body.data.state === "left" && nt.status === "active") return { ok: true };
    await db.query("update sa.call_notetakers set worker = $2 where id = $1", [
      id,
      body.data.state,
    ]);
    log("notetaker worker report", { notetaker: id, state: body.data.state });
    return { ok: true };
  });
}
