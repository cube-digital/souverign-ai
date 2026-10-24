import type { AgentRuntime, ChatMessage, ChatResult } from "./runtime.js";

/** Deterministic runtime for tests and e2e (AGENT_RUNTIME=echo). */
export class EchoRuntime implements AgentRuntime {
  async ensureStarted(): Promise<void> {}
  async chat(_agent: unknown, _chatId: string, messages: ChatMessage[]): Promise<ChatResult> {
    const text = `echo: ${messages.map((m) => m.content).join(" | ")}`.slice(0, 1500);
    return { content: text, reasoning: `echo: looked at ${messages.length} messages` };
  }
  async stop(): Promise<void> {}
  async stopAll(): Promise<void> {}
}
