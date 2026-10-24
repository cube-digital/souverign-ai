import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { llmTarget } from "./agents/hermes.js";
import { forceFirstTool } from "./agents/turn-policy.js";
import type { Db } from "./db.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** Templates without roster tools: nothing to force. */
const NO_FORCE_TEMPLATES = new Set(["general"]);

type Completion = {
  tools?: unknown;
  tool_choice?: unknown;
  messages?: { role?: string }[];
};

/**
 * Loopback-only proxy between a Hermes gateway and the local model server. It forces the first
 * model round of a tool-bearing agent's turn to call a tool (`tool_choice: "required"`), so vague
 * questions cannot skip the tools. Follow-up rounds and everything else pass through unchanged.
 */
export function registerLlmProxy(app: FastifyInstance, db: Db): void {
  const templates = new Map<string, string>();
  const templateOf = async (agentId: string): Promise<string | null> => {
    const cached = templates.get(agentId);
    if (cached) return cached;
    const [row] = await db.query<{ template: string }>(
      "select template from sa.agents where id = $1",
      [agentId],
    );
    if (row) templates.set(agentId, row.template);
    return row?.template ?? null;
  };

  /** Runs before the body is read: only a loopback gateway may talk to the proxy. */
  const loopbackOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // A browser or a reverse proxy in front of the bridge is not a gateway: refuse forwarded
    // requests and any Host that is not a loopback name (DNS rebinding).
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const forwarded = Object.keys(req.headers).some((h) => h.startsWith("x-forwarded-"));
    if (
      !LOOPBACK.has(req.socket.remoteAddress ?? "") ||
      forwarded ||
      !["127.0.0.1", "localhost", "[::1]"].includes(host)
    ) {
      await reply.code(403).send({ error: "forbidden" });
    }
  };

  /** Returns the agent's template, or null after replying 404. */
  const admit = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const template = await templateOf((req.params as { agentId: string }).agentId);
    if (!template) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    return template;
  };

  app.get("/llm/:agentId/v1/models", { onRequest: loopbackOnly }, async (req, reply) => {
    if (!(await admit(req, reply))) return;
    try {
      const up = await fetch(`${llmTarget().baseUrl}/models`);
      return reply
        .code(up.status)
        .header("content-type", up.headers.get("content-type") ?? "application/json")
        .send(await up.text());
    } catch {
      return reply.code(502).send({ error: "model_unavailable" });
    }
  });

  app.post(
    "/llm/:agentId/v1/chat/completions",
    { bodyLimit: 16 * 1024 * 1024, onRequest: loopbackOnly },
    async (req, reply) => {
      const template = await admit(req, reply);
      if (!template) return;
      const agentId = (req.params as { agentId: string }).agentId;
      const started = Date.now();
      const body = (req.body ?? {}) as Completion;
      const forced =
        !NO_FORCE_TEMPLATES.has(template) &&
        forceFirstTool(agentId) &&
        Array.isArray(body.tools) &&
        body.tools.length > 0 &&
        (body.tool_choice === undefined || body.tool_choice === "auto") &&
        !(body.messages ?? []).some((m) => m.role === "tool");
      const abort = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
        console.log(
          JSON.stringify({
            level: "info",
            msg: "llm proxy",
            agent: agentId,
            template,
            forced,
            ms: Date.now() - started,
          }),
        );
      });
      let up: Response;
      try {
        up = await fetch(`${llmTarget().baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(forced ? { ...body, tool_choice: "required" } : body),
          signal: abort.signal,
        });
      } catch {
        return reply.code(502).send({ error: "model_unavailable" });
      }
      reply.code(up.status);
      const type = up.headers.get("content-type");
      if (type) reply.header("content-type", type);
      if (!up.body) return reply.send();
      return reply.send(Readable.fromWeb(up.body as never));
    },
  );
}
