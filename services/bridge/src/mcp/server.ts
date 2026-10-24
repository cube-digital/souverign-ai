import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type RosterId, rosterEntry } from "@sa/protocol/roster";
import Fastify, { type FastifyInstance } from "fastify";
import { verifyMcpToken } from "../agents/secrets.js";
import type { Db } from "../db.js";
import { registeredTools, setToolDeps, toolCtx } from "./registry.js";
import { ToolLog } from "./tool-log.js";

const MAX_TOOLS = 20;

type Args = Record<string, unknown>;
type Ctx = {
  db: Db;
  agentId: string;
  opsSimUrl: string;
  chatId?: string | undefined;
  requester?: string | undefined;
};
type Tool = {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
  run: (ctx: Ctx, args: Args) => Promise<unknown>;
};

const sim = (path: string) => async (ctx: Ctx) => simGet(ctx, path);
async function simGet(ctx: Ctx, path: string): Promise<unknown> {
  const res = await fetch(`${ctx.opsSimUrl}${path}`);
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
    chat_id: { type: "string", description: "must be the chat of the current conversation" },
    limit: { type: "number", description: "1-50, default 20" },
  },
  required: ["chat_id"],
  async run(ctx, args) {
    const { db, agentId } = ctx;
    const chatId = String(args.chat_id ?? "");
    if (!ctx.chatId || chatId !== ctx.chatId) return { error: "not_current_chat" };
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

const DEV: Tool[] = [
  {
    name: "merge_requests",
    description: "Merge requests: id, title, author, state, pipeline and target branch.",
    properties: { state: { type: "string", description: "open, merged or all; default open" } },
    run: (ctx, a) =>
      simGet(
        ctx,
        `/sim/dev/merge-requests?state=${["merged", "all"].includes(String(a.state)) ? String(a.state) : "open"}`,
      ),
  },
  {
    name: "pipeline_status",
    description: "Most recent CI pipelines and their failed jobs.",
    properties: { limit: { type: "number", description: "1-10, default 5" } },
    run: (ctx, a) => simGet(ctx, `/sim/dev/pipelines?limit=${num(a.limit, 5, 10)}`),
  },
  {
    name: "build_log",
    description: "The last lines of the failed job of one pipeline.",
    properties: { pipeline_id: { type: "string" } },
    required: ["pipeline_id"],
    run: (ctx, a) => simGet(ctx, `/sim/dev/pipelines/${str(a.pipeline_id)}/log`),
  },
];

const DOCS: Tool[] = [
  {
    name: "docs_search",
    description: "Search runbooks and architecture notes; returns titles and snippets.",
    properties: { query: { type: "string" } },
    required: ["query"],
    run: (ctx, a) => simGet(ctx, `/sim/docs/search?q=${str(a.query)}`),
  },
  {
    name: "doc_read",
    description: "Read one document in full.",
    properties: { doc_id: { type: "string" } },
    required: ["doc_id"],
    run: (ctx, a) => simGet(ctx, `/sim/docs/${str(a.doc_id)}`),
  },
];

const CRM: Tool[] = [
  {
    name: "crm_accounts",
    description: "Customer accounts, optionally filtered by name.",
    properties: { query: { type: "string" } },
    run: (ctx, a) => simGet(ctx, `/sim/crm/accounts?q=${str(a.query)}`),
  },
  {
    name: "crm_deal",
    description: "One deal with its stage, amount and risks.",
    properties: { deal_id: { type: "string" } },
    required: ["deal_id"],
    run: (ctx, a) => simGet(ctx, `/sim/crm/deals/${str(a.deal_id)}`),
  },
  {
    name: "crm_activities",
    description: "Recent calls, emails and meetings of one account, newest first.",
    properties: { account_id: { type: "string" } },
    required: ["account_id"],
    run: (ctx, a) => simGet(ctx, `/sim/crm/accounts/${str(a.account_id)}/activities`),
  },
];

const chatDigest: Tool = {
  name: "chat_digest",
  description:
    "In a direct message: the latest messages of the other chats you share with the person who is asking.",
  properties: { since_hours: { type: "number", description: "1-72, default 24" } },
  async run(ctx, args) {
    const { db, agentId } = ctx;
    const requester = ctx.requester;
    if (!ctx.chatId || !requester) return { error: "digest_only_in_dm" };
    const members = await db.query<{ member_type: string; member_id: string }>(
      `select m.member_type, m.member_id from sa.chat_members m join sa.chats c on c.id = m.chat_id
       where m.chat_id = $1 and c.kind = 'dm' and m.removed_at is null`,
      [ctx.chatId],
    );
    const isDm =
      members.length === 2 &&
      members.some((m) => m.member_type === "agent" && m.member_id === agentId) &&
      members.some((m) => m.member_type === "user" && m.member_id === requester);
    if (!isDm) return { error: "digest_only_in_dm" };
    const since = Date.now() - num(args.since_hours, 24, 72) * 3_600_000;
    const chats = await db.query<{ id: string; title: string }>(
      `select c.id, c.title from sa.chats c
       join sa.chat_members a on a.chat_id = c.id and a.member_type = 'agent' and a.member_id = $1 and a.removed_at is null
       join sa.chat_members u on u.chat_id = c.id and u.member_type = 'user' and u.member_id = $2 and u.removed_at is null
       where c.id <> $3
       order by (select max(ts) from sa.messages_plain p
                 join sa.agent_devices ad on ad.device_id = p.device_id and ad.agent_id = $1
                 where p.chat_id = c.id) desc nulls last
       limit 8`,
      [agentId, requester, ctx.chatId],
    );
    const out: { chat_title: string; messages: { sender: string; text: string; ts: number }[] }[] =
      [];
    for (const c of chats) {
      const rows = await db.query<{ sender: string | null; body: { text?: string }; ts: string }>(
        `select * from (
           select distinct on (m.id) coalesce(us.display_name, ag.name, 'unknown') as sender,
                  m.body, m.ts, m.seq
           from sa.messages_plain m
           join sa.agent_devices me on me.device_id = m.device_id and me.agent_id = $2
           join sa.chats c on c.id = m.chat_id
           join sa.chat_members rq on rq.chat_id = m.chat_id and rq.member_type = 'user'
             and rq.member_id = $4 and rq.removed_at is null
           join sa.chat_members am on am.chat_id = m.chat_id and am.member_type = 'agent'
             and am.member_id = $2 and am.removed_at is null
           left join sa.devices d on d.id = m.sender_device
           left join sa.users us on d.owner_type = 'user' and us.id = d.owner_id
           left join sa.agents ag on d.owner_type = 'agent' and ag.id = d.owner_id
           where m.chat_id = $1 and m.body->>'type' = 'text' and m.ts >= $3
             and (m.seq <= coalesce(c.history_until_seq, -1)
                  or (m.ts >= extract(epoch from rq.joined_at) * 1000
                      and m.ts >= extract(epoch from am.joined_at) * 1000))
           order by m.id, m.seq
         ) t order by seq desc limit 15`,
        [c.id, agentId, since, requester],
      );
      out.push({
        chat_title: c.title,
        messages: rows.reverse().map((r) => ({
          sender: r.sender ?? "unknown",
          text: r.body.text ?? "",
          ts: Number(r.ts),
        })),
      });
    }
    return out;
  },
};

const GENERAL: Tool[] = [
  {
    name: "image_generate",
    description: "Generate an image.",
    properties: { prompt: { type: "string" } },
    required: ["prompt"],
    run: async () => ({ error: "unavailable_in_profile" }),
  },
];

const CATALOG = new Map<string, Tool>(
  [...OPS, ...QA, ...DEV, ...DOCS, ...CRM, chatDigest].map((t) => [t.name, t]),
);
const fromRoster = (id: RosterId): Tool[] =>
  (rosterEntry(id)?.tools ?? [])
    .filter((n) => n !== "chat_read")
    .flatMap((n) => CATALOG.get(n) ?? []);

const BY_TEMPLATE: Record<string, Tool[]> = {
  general: GENERAL,
  devops: OPS,
  ops: fromRoster("ops"),
  qa: fromRoster("qa"),
  dev: fromRoster("dev"),
  tech: fromRoster("tech"),
  sales: fromRoster("sales"),
  scribe: fromRoster("scribe"),
};

export type McpAppOptions = { db: Db; opsSimUrl?: string; toolLog?: ToolLog };

export function buildMcpApp(opts: McpAppOptions): FastifyInstance {
  const app = Fastify({ logger: false, forceCloseConnections: true });
  registerMcp(app, {
    db: opts.db,
    opsSimUrl: opts.opsSimUrl ?? process.env.OPS_SIM_URL ?? "http://127.0.0.1:8649",
    toolLog: opts.toolLog ?? new ToolLog(),
  });
  return app;
}

/** Adds the /mcp routes (bearer MCP token auth, independent of user sessions) to `app`. */
export function registerMcp(
  app: FastifyInstance,
  opts: { db: Db; opsSimUrl: string; toolLog: ToolLog },
): void {
  const opsSimUrl = opts.opsSimUrl.replace(/\/$/, "");
  const toolLog = opts.toolLog;
  const deps = { db: opts.db, opsSimUrl, toolLog };
  setToolDeps(deps);

  async function toolsFor(agentId: string): Promise<Tool[] | null> {
    const [row] = await opts.db.query<{ template: string }>(
      "select template from sa.agents where id = $1",
      [agentId],
    );
    if (!row) return null;
    const builtIn = [chatRead, ...(BY_TEMPLATE[row.template] ?? [])];
    const template = row.template;
    const extras: Tool[] = registeredTools(template).map((r) => ({
      name: r.name,
      description: r.description,
      properties: r.properties as Tool["properties"],
      ...(r.required ? { required: r.required } : {}),
      // registered tools return text; it is passed through as is
      run: (_ctx, args) => r.run(toolCtx(deps, agentId, template), args),
    }));
    const room = Math.max(0, MAX_TOOLS - builtIn.length);
    if (extras.length > room) {
      console.log(
        JSON.stringify({
          level: "warn",
          msg: "mcp tool cap reached",
          agent: agentId,
          template,
          dropped: extras.length - room,
        }),
      );
    }
    return [...builtIn, ...extras.slice(0, room)];
  }

  function serverFor(agentId: string, tools: Tool[], turnId?: string): Server {
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
      if (!toolLog.accepts(agentId, turnId)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify({ error: "no_active_turn" }) }],
        };
      }
      const args = (req.params.arguments ?? {}) as Args;
      const started = Date.now();
      let text: string;
      let isError = false;
      try {
        const out = await tool.run(
          {
            db: opts.db,
            agentId,
            opsSimUrl,
            chatId: toolLog.chatId(agentId),
            requester: toolLog.requester(agentId),
          },
          args,
        );
        text = typeof out === "string" ? out : JSON.stringify(out);
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
    const turnHeader = req.headers["x-sa-turn"];
    const server = serverFor(
      agentId,
      tools,
      typeof turnHeader === "string" ? turnHeader : undefined,
    );
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
