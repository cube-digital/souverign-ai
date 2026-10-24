import type { AgentRuntime, ChatMessage, ChatResult } from "./runtime.js";

/** Deterministic runtime for tests and e2e (AGENT_RUNTIME=echo). */
export class EchoRuntime implements AgentRuntime {
  async ensureStarted(): Promise<void> {}
  async chat(_agent: unknown, _chatId: string, messages: ChatMessage[]): Promise<ChatResult> {
    const text = `echo: ${messages.map((m) => m.content).join(" | ")}`.slice(0, 1500);
    return { content: text, reasoning: `echo: looked at ${messages.length} messages` };
  }
  async chatStream(
    agent: unknown,
    chatId: string,
    messages: ChatMessage[],
    onDelta: (text: string) => void,
  ): Promise<ChatResult> {
    const result = await this.chat(agent, chatId, messages);
    for (const word of result.content.split(/(?<=\s)/)) {
      await new Promise((r) => setTimeout(r, 40));
      onDelta(word);
    }
    return result;
  }
  async stop(): Promise<void> {}
  async stopAll(): Promise<void> {}
}
