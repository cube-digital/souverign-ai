import type { MemoryScope } from "./client.js";

export type ScopeAgent = {
  id: string;
  scope: "personal" | "workspace";
  ownerUserId: string | null;
  share: "always" | "ask" | "never";
};
export type ScopeChat = {
  id: string;
  kind: "dm" | "group" | "room";
  /** epoch ms of the agent's current membership; null when it is not an active member */
  agentJoinedAt: number | null;
  /** active human member ids */
  humans: string[];
  /** active agent member ids */
  agents: string[];
};
/** Chats where this agent and the 1:1 human are both active members, with the agent's joined_at. */
export type SharedChat = { id: string; agentJoinedAt: number };
export type ScopeInput = {
  agent: ScopeAgent;
  chat: ScopeChat;
  shared: SharedChat[];
  noTaught: boolean;
  /** someone can approve an `ask` answer (owner, or the requester for workspace agents) */
  approverAvailable: boolean;
};

/** The human of a 1:1 with this agent, or null when the chat is shared. */
export function oneToOneHuman(agent: ScopeAgent, chat: ScopeChat): string | null {
  if (chat.kind !== "dm" || chat.humans.length !== 1) return null;
  if (chat.agents.length !== 1 || chat.agents[0] !== agent.id) return null;
  const u = chat.humans[0] as string;
  if (agent.scope === "personal" && agent.ownerUserId !== u) return null;
  return u;
}

export function taughtAllowed(inp: ScopeInput): boolean {
  if (inp.noTaught) return false;
  if (inp.agent.share === "always") return true;
  return inp.agent.share === "ask" && inp.approverAvailable;
}

export function recallScopes(inp: ScopeInput): MemoryScope[] {
  const { agent, chat } = inp;
  if (chat.agentJoinedAt === null) return [];
  const own = `agent:${agent.id}`;
  if (oneToOneHuman(agent, chat)) {
    const chats = [
      { id: chat.id, agentJoinedAt: chat.agentJoinedAt },
      ...inp.shared.filter((s) => s.id !== chat.id),
    ];
    const chatScopes = chats.map((c) => ({ namespace: `chat:${c.id}`, since_ts: c.agentJoinedAt }));
    const agentScope: MemoryScope =
      agent.scope === "personal"
        ? { namespace: own, origin_chat_ids: null }
        : { namespace: own, origin_chat_ids: [null, ...chats.map((c) => c.id)] };
    return [agentScope, ...chatScopes];
  }
  return [
    { namespace: own, origin_chat_ids: taughtAllowed(inp) ? [chat.id, null] : [chat.id] },
    { namespace: `chat:${chat.id}`, since_ts: chat.agentJoinedAt },
  ];
}
