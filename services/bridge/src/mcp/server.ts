import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import Fastify, { type FastifyInstance } from "fastify";
import { verifyMcpToken } from "../agents/secrets.js";
import type { Db } from "../db.js";
import { ToolLog } from "./tool-log.js";

type Args = Record<string, unknown>;
type Ctx = { db: Db; agentId: string; rtSimUrl: string };
type Tool = {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
  run: (ctx: Ctx, args: Args) => Promise<unknown>;
};

const sim = (path: string) => async (ctx: Ctx) => simGet(ctx, path);
async function simGet(ctx: Ctx, path: string): Promise<unknown> {
  const res = await fetch(`${ctx.rtSimUrl}${path}`);
  return res.json();
}
const num = (v: unknown, dflt: number, max: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
};
const str = (v: unknown): string => encodeURIComponent(String(v ?? ""));

const chatRead: Tool = {
  name: "chat_read",
  description: "Read the latest messages of a chat you are a member of, oldest first.",
  properties: {
    chat_id: { type: "string" },
    limit: { type: "number", description: "1-50, default 20" },
  },
  required: ["chat_id"],
  async run({ db, agentId }, args) {
    const chatId = String(args.chat_id ?? "");
    const [member] = await db.query(
      `select 1 from sa.chat_members
       where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null`,
      [chatId, agentId],
    );
    if (!member) return { error: "not_a_member" };
    const rows = await db.query<{ sender: string | null; body: { text?: string }; ts: string }>(
      `select coalesce(u.display_name, ag.name, 'unknown') as sender, m.body, m.ts
       from sa.messages_plain m
       join sa.agent_devices me on me.device_id = m.device_id and me.agent_id = $2
       left join sa.devices d on d.id = m.sender_device
       left join sa.users u on d.owner_type = 'user' and u.id = d.owner_id
       left join sa.agents ag on d.owner_type = 'agent' and ag.id = d.owner_id
       where m.chat_id = $1 order by m.seq desc limit $3`,
      [chatId, agentId, num(args.limit, 20, 50)],
    );
    return rows.reverse().map((r) => ({
      sender: r.sender,
      text: r.body.text ?? `[${(r.body as { type?: string }).type}]`,
      ts: Number(r.ts),
    }));
  },
};

const lastSeen: Tool = {
  name: "user_last_seen",
  description: "When a user was last seen online.",
  properties: { username: { type: "string" } },
  required: ["username"],
  run: (ctx, a) => simGet(ctx, `/sim/users/${str(a.username)}/last-seen`),
};

const OPS: Tool[] = [
  {
    name: "cluster_health",
    description: "Health of every cluster node.",
    properties: {},
    run: sim("/sim/cluster/health"),
  },
  {
    name: "raft_status",
    description: "Raft leader and term.",
    properties: {},
    run: sim("/sim/raft"),
  },
  {
    name: "db_sync_status",
    description: "Database replication lag.",
    properties: {},
    run: sim("/sim/db/sync"),
  },
  {
    name: "metric_trend",
    description: "Trend of one metric on one node.",
    properties: {
      node: { type: "string" },
      metric: { type: "string" },
      hours: { type: "number" },
    },
    required: ["node", "metric"],
    run: (ctx, a) =>
      simGet(ctx, `/sim/metrics/${str(a.node)}/${str(a.metric)}?hours=${num(a.hours, 6, 72)}`),
  },
  {
    name: "recent_alerts",
    description: "Alerts raised in the last hours.",
    properties: { hours: { type: "number" } },
    run: (ctx, a) => simGet(ctx, `/sim/alerts?hours=${num(a.hours, 24, 168)}`),
  },
  lastSeen,
];

const QA: Tool[] = [
  {
    name: "test_runs",
    description: "Most recent test runs.",
    properties: { limit: { type: "number" } },
    run: (ctx, a) => simGet(ctx, `/sim/qa/test-runs?limit=${num(a.limit, 10, 12)}`),
  },
  {
    name: "flaky_tests",
    description: "Tests that fail intermittently.",
    properties: {},
    run: sim("/sim/qa/flaky"),
  },
  {
    name: "release_status",
    description: "Release readiness.",
    properties: {},
    run: sim("/sim/release/status"),
  },
  {
    name: "open_tickets",
    description: "Open tickets.",
    properties: {},
    run: sim("/sim/tickets?status=open"),
  },
  lastSeen,
];

const GENERAL: Tool[] = [
  {
    name: "image_generate",
    description: "Generate an image.",
    properties: { prompt: { type: "string" } },
    required: ["prompt"],
    run: async () => ({ error: "unavailable_in_profile" }),
  },
];

const BY_TEMPLATE: Record<string, Tool[]> = { general: GENERAL, devops: OPS, qa: QA };

export type McpAppOptions = { db: Db; rtSimUrl?: string; toolLog?: ToolLog };

export function buildMcpApp(opts: McpAppOptions): FastifyInstance {
  const app = Fastify({ logger: false, forceCloseConnections: true });
  registerMcp(app, {
    db: opts.db,
    rtSimUrl: opts.rtSimUrl ?? process.env.RT_SIM_URL ?? "http://127.0.0.1:8649",
    toolLog: opts.toolLog ?? new ToolLog(),
  });
  return app;
}

/** Adds the /mcp routes (bearer MCP token auth, independent of user sessions) to `app`. */
export function registerMcp(
  app: FastifyInstance,
  opts: { db: Db; rtSimUrl: string; toolLog: ToolLog },
): void {
  const rtSimUrl = opts.rtSimUrl.replace(/\/$/, "");
  const toolLog = opts.toolLog;

  async function toolsFor(agentId: string): Promise<Tool[] | null> {
    const [row] = await opts.db.query<{ template: string }>(
      "select template from sa.agents where id = $1",
      [agentId],
    );
    return row ? [chatRead, ...(BY_TEMPLATE[row.template] ?? [])] : null;
  }

  function serverFor(agentId: string, tools: Tool[]): Server {
    const server = new Server(
      { name: "sa-bridge", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: {
          type: "object" as const,
          properties: t.properties,
          required: t.required ?? [],
        },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = tools.find((t) => t.name === req.params.name);
      if (!tool) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `unknown tool: ${req.params.name}` }],
        };
      }
      const args = (req.params.arguments ?? {}) as Args;
      const started = Date.now();
      let text: string;
      let isError = false;
      try {
        text = JSON.stringify(await tool.run({ db: opts.db, agentId, rtSimUrl }, args));
      } catch (e) {
        isError = true;
        text = JSON.stringify({ error: "tool_failed", message: (e as Error).message });
      }
      const ms = Date.now() - started;
      toolLog.record(agentId, { name: tool.name, args, result: text, ms });
      console.log(
        JSON.stringify({ level: "info", msg: "mcp tool", agent: agentId, tool: tool.name, ms }),
      );
      return { isError, content: [{ type: "text" as const, text }] };
    });
    return server;
  }

  app.all("/mcp", async (req, reply) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const agentId = m?.[1] ? verifyMcpToken(m[1]) : null;
    const tools = agentId ? await toolsFor(agentId) : null;
    if (!agentId || !tools) return reply.code(401).send({ error: "unauthorized" });
    if (!["POST", "GET", "DELETE"].includes(req.method)) {
      return reply.code(405).send({ error: "method_not_allowed" });
    }
    // Stateless: a fresh server and transport per request.
    const server = serverFor(agentId, tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}
