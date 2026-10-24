import { invokeTool } from "../mcp/registry.js";
import {
  type AgentRuntime,
  abortableSleep,
  abortError,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
} from "./runtime.js";

const TOOL_RE = /!tool\s+([a-z_]+)\s+(\{[\s\S]*\})\s*$/;

/** Deterministic runtime for tests and e2e (AGENT_RUNTIME=echo). `delayMs` simulates a slow
 * model; the wait and the stream honour the turn's abort signal. */
export class EchoRuntime implements AgentRuntime {
  private delayMs: number;

  constructor(opts: { delayMs?: number } = {}) {
    this.delayMs = opts.delayMs ?? 0;
  }

  async ensureStarted(): Promise<void> {}
  async chat(
    agent: { id: string },
    _chatId: string,
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    if (this.delayMs > 0) await abortableSleep(this.delayMs, opts?.signal);
    const last = [...messages].reverse().find((m) => m.role === "user");
    const call = last ? TOOL_RE.exec(last.content) : null;
    if (call) {
      let args: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(call[2] ?? "");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          args = parsed as Record<string, unknown>;
      } catch {}
      if (!args) return { content: "echo: bad tool args" };
      if (opts?.signal?.aborted) throw abortError();
      const result = await invokeTool(agent.id, call[1] ?? "", args);
      if (opts?.signal?.aborted) throw abortError();
      return { content: `echo: ${call[1]} -> ${result}`.slice(0, 1500) };
    }
    const text = `echo: ${messages.map((m) => m.content).join(" | ")}`.slice(0, 1500);
    return { content: text, reasoning: `echo: looked at ${messages.length} messages` };
  }
  async chatStream(
    agent: { id: string },
    chatId: string,
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    const result = await this.chat(agent, chatId, messages, opts);
    for (const word of result.content.split(/(?<=\s)/)) {
      await abortableSleep(40, opts?.signal);
      onDelta(word);
    }
    return result;
  }
  modelName(): string {
    return "echo";
  }
  async stop(): Promise<void> {}
  async stopAll(): Promise<void> {}
}
