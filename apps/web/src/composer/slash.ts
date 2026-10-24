export type SlashAgent = { name: string; inChat: boolean };
export type SlashCtx = { inThread: boolean; agents: SlashAgent[] };

export const SLASH_COMMANDS = [
  { name: "/summarize", arg: false, hint: "Scribe summarizes this chat or thread" },
  { name: "/catchup", arg: false, hint: "Scribe tells you what you missed" },
  { name: "/standup", arg: false, hint: "Scribe writes today's standup" },
  { name: "/ask", arg: true, hint: "/ask <agent> <question>" },
  { name: "/access", arg: true, hint: "/access [agent] · what an agent can see here" },
] as const;

const find = (ctx: SlashCtx, name: string) =>
  ctx.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());

/** Turns a slash command into the visible agent request that is sent; other text passes through. */
export function expandSlash(text: string, ctx: SlashCtx): { text: string } | { error: string } {
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const cmd = m?.[1]?.toLowerCase();
  const rest = (m?.[2] ?? "").trim();
  if (!cmd || !SLASH_COMMANDS.some((c) => c.name === `/${cmd}`)) return { text };
  if (cmd === "ask") {
    const [who = "", ...words] = rest.split(/\s+/);
    if (!who || words.length === 0) return { error: "Use /ask <agent> <question>" };
    const agent = find(ctx, who);
    return agent
      ? { text: `@${agent.name} ${words.join(" ")}` }
      : { error: `No agent called ${who}` };
  }
  if (cmd === "access") {
    if (rest) {
      const agent = find(ctx, rest);
      return agent
        ? { text: `@${agent.name} what can you access here?` }
        : { error: `No agent called ${rest}` };
    }
    const inChat = ctx.agents.filter((a) => a.inChat);
    if (inChat.length === 0) return { error: "No agents in this chat" };
    return { text: `${inChat.map((a) => `@${a.name}`).join(" ")} what can you access here?` };
  }
  const scribe = find(ctx, "Scribe");
  if (!scribe) return { error: "No agent called Scribe" };
  const tail = {
    summarize: `summarize this ${ctx.inThread ? "thread" : "chat"}`,
    catchup: "what did I miss?",
    standup: "write a standup for today from this chat: done, next, blockers",
  }[cmd];
  return { text: `@${scribe.name} ${tail}` };
}
