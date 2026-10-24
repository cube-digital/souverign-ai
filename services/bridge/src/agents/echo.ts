import {
  type AgentRuntime,
  abortableSleep,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
} from "./runtime.js";

/** Deterministic runtime for tests and e2e (AGENT_RUNTIME=echo). `delayMs` simulates a slow
 * model; the wait and the stream honour the turn's abort signal. */
export class EchoRuntime implements AgentRuntime {
  private delayMs: number;

  constructor(opts: { delayMs?: number } = {}) {
    this.delayMs = opts.delayMs ?? 0;
  }

  async ensureStarted(): Promise<void> {}
  async chat(
    _agent: unknown,
    _chatId: string,
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    if (this.delayMs > 0) await abortableSleep(this.delayMs, opts?.signal);
    const text = `echo: ${messages.map((m) => m.content).join(" | ")}`.slice(0, 1500);
    return { content: text, reasoning: `echo: looked at ${messages.length} messages` };
  }
  async chatStream(
    agent: unknown,
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
