import { ApprovalDecision } from "@sa/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { hashToken } from "../auth.js";
import type { RouteDeps } from "../plugin-api.js";
import { registerEventsRoute } from "./events.js";
import { registerQuestionRoutes } from "./questions.js";
import { cancel, decide, gatedTool, toPublic } from "./service.js";
import {
  type ApprovalRow,
  deleteGrant,
  getApproval,
  isHumanMember,
  listForApprover,
  listForRequester,
  listGrants,
  rowToApproval,
} from "./store.js";

const full = (r: ApprovalRow) =>
  rowToApproval(r, gatedTool(r.tool)?.executor.alwaysAllowed ?? false);

export function registerApprovalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, authenticate } = deps;

  /** The stream ends when its session is gone (logout or expiry). */
  const alive = async (req: FastifyRequest): Promise<boolean> => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m?.[1]) return false;
    const rows = await db.query(
      "select 1 from sa.sessions where token_hash = $1 and expires_at > now()",
      [hashToken(m[1])],
    );
    return rows.length > 0;
  };
  registerEventsRoute(app, authenticate, alive);
  registerQuestionRoutes(app, { db, authenticate });

  app.get("/api/approvals", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const q = req.query as { status?: string; agent_id?: string; role?: string };
    const status = q.status === "all" ? "all" : "pending";
    const filter = { status, agentId: q.agent_id || undefined } as const;
    if (q.role === "requester") {
      return (await listForRequester(db, userId, filter)).map((r) => toPublic(full(r)));
    }
    return (await listForApprover(db, userId, filter)).map(full);
  });

  app.get("/api/approvals/:id/public", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const row = await getApproval(db, (req.params as { id: string }).id);
    if (!row || !(await isHumanMember(db, row.chat_id, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }
    return toPublic(full(row));
  });

  app.post("/api/approvals/:id/decision", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const body = ApprovalDecision.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const r = await decide((req.params as { id: string }).id, userId, body.data);
    if (r.ok) return r.approval;
    if (r.code === "not_found") return reply.code(404).send({ error: "not_found" });
    if (r.code === "invalid_args") return reply.code(422).send({ error: "invalid_args" });
    if (r.code === "expired") return reply.code(409).send({ error: "expired" });
    return reply.code(409).send({ error: "already_decided", approval: r.approval });
  });

  app.post("/api/approvals/:id/cancel", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const id = (req.params as { id: string }).id;
    const r = await cancel(id, userId);
    // The requester sees the full approval only when they are also the approver.
    const view = (a: ReturnType<typeof full>) => (a.approver_user_id === userId ? a : toPublic(a));
    if (r.ok) return view(r.approval);
    if (r.code === "not_found") return reply.code(404).send({ error: "not_found" });
    const row = await getApproval(db, id);
    return reply.code(409).send({
      error: "already_decided",
      ...(row ? { approval: view(full(row)) } : {}),
    });
  });

  app.get("/api/approval-grants", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    return listGrants(db, userId);
  });

  app.delete("/api/approval-grants/:agentId/:tool", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const p = req.params as { agentId: string; tool: string };
    if (!(await deleteGrant(db, userId, p.agentId, p.tool))) {
      return reply.code(404).send({ error: "not_found" });
    }
    return { ok: true };
  });
}
