import { EventEmitter } from "node:events";
import type { TraceStep } from "@sa/protocol";

type ToolStep = Extract<TraceStep, { kind: "tool" }>;

/** Per-agent record of MCP tool calls, so the reply can carry its trace. */
export class ToolLog extends EventEmitter {
  /** Emits `tool` (agentId, name) for every recorded call. */
  private steps = new Map<string, ToolStep[]>();

  private chats = new Map<string, string>();

  private requesters = new Map<string, string | undefined>();

  private turns = new Map<string, string>();

  /** Agents that have run a turn through this log; between turns their calls are refused. */
  private hosted = new Set<string>();

  /** `turnId` is the turn the calls belong to; calls for any other turn are refused. */
  begin(
    agentId: string,
    chatId: string,
    ctx: { requesterUserId?: string; turnId?: string } = {},
  ): void {
    this.steps.set(agentId, []);
    this.hosted.add(agentId);
    if (ctx.turnId) this.turns.set(agentId, ctx.turnId);
    else this.turns.delete(agentId);
    this.chats.set(agentId, chatId);
    this.requesters.set(agentId, ctx.requesterUserId);
  }

  /** The turn in progress for the agent, if any. */
  activeTurn(agentId: string): string | undefined {
    return this.turns.get(agentId);
  }

  /** Whether a tool call may run now: a turn is in progress and, if the call names its turn, it is
   * that one. A call from a turn that already ended or was stopped is refused. */
  accepts(agentId: string, turnId?: string): boolean {
    if (!this.steps.has(agentId)) return !this.hosted.has(agentId) && turnId === undefined;
    const active = this.turns.get(agentId);
    return turnId === undefined || active === undefined || active === turnId;
  }

  /** The requester of the agent's turn in progress, if any. */
  requester(agentId: string): string | undefined {
    return this.requesters.get(agentId);
  }

  /** The chat of the agent's turn in progress, if any. */
  chatId(agentId: string): string | undefined {
    return this.chats.get(agentId);
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
    this.emit("tool", agentId, step.name.slice(0, 64));
  }

  end(agentId: string): TraceStep[] {
    const list = this.steps.get(agentId) ?? [];
    this.steps.delete(agentId);
    this.chats.delete(agentId);
    this.requesters.delete(agentId);
    this.turns.delete(agentId);
    return list;
  }
}
