import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "../plugin-api.js";
import { republish } from "./publish.js";

/** `POST /api/calls/notes/:notesId/republish`: the inviter publishes denied or expired notes again. */
export function registerNotesRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/api/calls/notes/:notesId/republish", async (req, reply) => {
    const userId = await deps.authenticate(req, reply);
    if (!userId) return;
    const r = await republish((req.params as { notesId: string }).notesId, userId);
    if (!r.ok) return reply.code(r.status).send({ error: r.code });
    return { approval_id: r.approvalId };
  });
}
