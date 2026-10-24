import { currentTurn, type TurnContext } from "../agents/turn-hooks.js";
import type { Db } from "../db.js";
import type { ToolLog } from "./tool-log.js";

export type ToolCtx = {
  db: Db;
  agentId: string;
  template: string;
  chatId?: string | undefined;
  requesterUserId?: string | undefined;
  turn?: TurnContext | undefined;
  opsSimUrl: string;
};
export type RegisteredTool = {
  name: string;
  description: string;
  /** JSON Schema `properties` of the input object */
  properties: Record<string, unknown>;
  required?: string[];
  run(ctx: ToolCtx, args: Record<string, unknown>): Promise<string>;
};

const byTemplate = new Map<string, Map<string, RegisteredTool>>();

export function registerTools(
  templates: readonly string[],
  tools: readonly RegisteredTool[],
): void {
  for (const t of templates) {
    const m = byTemplate.get(t) ?? new Map<string, RegisteredTool>();
    for (const tool of tools) m.set(tool.name, tool);
    byTemplate.set(t, m);
  }
}
export function registeredTools(template: string): RegisteredTool[] {
  return [...(byTemplate.get(template)?.values() ?? [])];
}
/** Tests only. */
export function clearRegisteredTools(): void {
  byTemplate.clear();
}

type Deps = { db: Db; opsSimUrl: string; toolLog: ToolLog };
let deps: Deps | null = null;
/** registerMcp calls this once. */
export function setToolDeps(d: Deps): void {
  deps = d;
}

export function toolCtx(d: Deps, agentId: string, template: string): ToolCtx {
  return {
    db: d.db,
    agentId,
    template,
    chatId: d.toolLog.chatId(agentId),
    requesterUserId: d.toolLog.requester(agentId),
    turn: currentTurn(agentId),
    opsSimUrl: d.opsSimUrl,
  };
}

/** Calls a registered tool the way MCP would (allowlist, ToolLog). Used by the echo runtime. */
export async function invokeTool(
  agentId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!deps) return "tools are not ready";
  const [row] = await deps.db.query<{ template: string }>(
    "select template from sa.agents where id = $1",
    [agentId],
  );
  const tool = row ? byTemplate.get(row.template)?.get(name) : undefined;
  if (!row || !tool) {
    const result = `unknown tool: ${name}`;
    deps.toolLog.record(agentId, { name, args, result, ms: 0 });
    return result;
  }
  const t0 = Date.now();
  let result: string;
  try {
    result = await tool.run(toolCtx(deps, agentId, row.template), args);
  } catch (e) {
    result = `error: ${(e as Error).message.slice(0, 200)}`;
  }
  deps.toolLog.record(agentId, { name, args, result, ms: Date.now() - t0 });
  return result;
}
