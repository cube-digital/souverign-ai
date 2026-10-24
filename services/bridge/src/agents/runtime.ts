export type RuntimeAgent = {
  id: string;
  name: string;
  template: string;
  soul: string;
  ownerName: string;
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatResult = { content: string; reasoning?: string };

export interface AgentRuntime {
  ensureStarted(agent: RuntimeAgent): Promise<void>;
  chat(agent: RuntimeAgent, chatId: string, messages: ChatMessage[]): Promise<ChatResult>;
  /** Like `chat`, but reports content deltas as they arrive; hosts fall back to `chat` without it. */
  chatStream?(
    agent: RuntimeAgent,
    chatId: string,
    messages: ChatMessage[],
    onDelta: (text: string) => void,
  ): Promise<ChatResult>;
  stop(agent: RuntimeAgent): Promise<void>;
  stopAll(): Promise<void>;
}

/** Splits `<think>…</think>` blocks out of model content. */
export function splitThink(content: string): ChatResult {
  const parts: string[] = [];
  const clean = content
    .replace(/<think>([\s\S]*?)<\/think>/g, (_m, t: string) => {
      parts.push(t.trim());
      return "";
    })
    .trim();
  const reasoning = parts.filter(Boolean).join("\n\n");
  return reasoning ? { content: clean, reasoning } : { content: clean };
}
