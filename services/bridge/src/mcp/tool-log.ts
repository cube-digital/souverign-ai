import type { TraceStep } from "@sa/protocol";

type ToolStep = Extract<TraceStep, { kind: "tool" }>;

/** Per-agent record of MCP tool calls, so the reply can carry its trace. */
export class ToolLog {
  private steps = new Map<string, ToolStep[]>();

  begin(agentId: string): void {
    this.steps.set(agentId, []);
  }

  record(agentId: string, step: { name: string; args: unknown; result: string; ms: number }): void {
    const list = this.steps.get(agentId);
    if (!list) return;
    const args = typeof step.args === "string" ? step.args : JSON.stringify(step.args ?? {});
    list.push({
      kind: "tool",
      name: step.name.slice(0, 64),
      args: args.slice(0, 500),
      result: step.result.slice(0, 1500),
      ms: Math.max(0, Math.round(step.ms)),
    });
  }

  end(agentId: string): TraceStep[] {
    const list = this.steps.get(agentId) ?? [];
    this.steps.delete(agentId);
    return list;
  }
}
