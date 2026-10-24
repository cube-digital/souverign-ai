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

/**
 * The part of streamed `content` that is safe to show live: closed think blocks are dropped, an
 * unclosed `<think>` hides everything after it, and a trailing partial `<think` tag is held back.
 * Output only grows as content grows, so callers can emit the suffix they have not sent yet.
 */
export function visibleStream(content: string): string {
  let out = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = out.indexOf("<think>");
  if (open >= 0) return out.slice(0, open);
  const tag = "<think>";
  for (let n = Math.min(tag.length - 1, out.length); n > 0; n--) {
    if (out.endsWith(tag.slice(0, n))) {
      out = out.slice(0, out.length - n);
      break;
    }
  }
  return out;
}
