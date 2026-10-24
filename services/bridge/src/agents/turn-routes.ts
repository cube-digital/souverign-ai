import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentHostApi } from "./api.js";

export type TurnRoutesDeps = {
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<string | null>;
  agentHost?: AgentHostApi | undefined;
};

/** `POST /api/turns/:turnId/stop`: only the person who triggered the turn may stop it. */
export function registerTurnRoutes(app: FastifyInstance, deps: TurnRoutesDeps): void {
  app.post<{ Params: { turnId: string } }>("/api/turns/:turnId/stop", async (req, reply) => {
    const userId = await deps.authenticate(req, reply);
    if (!userId) return;
    const result = deps.agentHost?.stopTurn?.(req.params.turnId, userId) ?? "not_found";
    if (result === "stopped") return { stopped: true };
    if (result === "forbidden") return reply.code(403).send({ error: "forbidden" });
    return reply.code(404).send({ error: "not_found" });
  });
}
