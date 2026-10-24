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
  /** epoch ms of the requester's (the 1:1 human's) join to this chat; absent = no extra bound */
  requesterJoinedAt?: number | null | undefined;
  /** the chat carries shared history (D-12): its early messages are visible to every member */
  historyShared?: boolean | undefined;
  /** active human member ids */
  humans: string[];
  /** active agent member ids */
  agents: string[];
};
/** Chats where this agent and the 1:1 human are both active members, with the agent's joined_at. */
export type SharedChat = {
  id: string;
  agentJoinedAt: number;
  requesterJoinedAt?: number | null | undefined;
  historyShared?: boolean | undefined;
};

/**
 * Earliest message time the agent may recall from a chat for this requester: the later of the
 * agent's join and the requester's join (mirrors chat_digest), except in D-12 shared history.
 * Rounded up so it never lands before the real join.
 */
export function chatSince(c: {
  agentJoinedAt: number;
  requesterJoinedAt?: number | null | undefined;
  historyShared?: boolean | undefined;
}): number {
  const agent = Math.ceil(c.agentJoinedAt);
  if (c.historyShared || c.requesterJoinedAt == null) return agent;
  return Math.max(agent, Math.ceil(c.requesterJoinedAt));
}
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
      {
        id: chat.id,
        agentJoinedAt: chat.agentJoinedAt,
        requesterJoinedAt: chat.requesterJoinedAt,
        historyShared: chat.historyShared,
      },
      ...inp.shared.filter((s) => s.id !== chat.id),
    ];
    const chatScopes = chats.map((c) => ({ namespace: `chat:${c.id}`, since_ts: chatSince(c) }));
    if (agent.scope === "personal")
      return [{ namespace: own, origin_chat_ids: null }, ...chatScopes];
    // Workspace 1:1 (D-13): taught notes (null origin) are always readable here. A 1:1 is not a
    // shared chat, so the `never`/`ask` rules of D-9 (which gate taught text in shared chats) do
    // not apply; notes learned in this DM and in chats the person shares follow those chats' bounds.
    return [
      { namespace: own, origin_chat_ids: [null] },
      ...chats.map((c) => ({ namespace: own, origin_chat_ids: [c.id], since_ts: chatSince(c) })),
      ...chatScopes,
    ];
  }
  const since = chatSince({ ...chat, agentJoinedAt: chat.agentJoinedAt });
  return [
    { namespace: own, origin_chat_ids: [chat.id], since_ts: since },
    ...(taughtAllowed(inp) ? [{ namespace: own, origin_chat_ids: [null] }] : []),
    { namespace: `chat:${chat.id}`, since_ts: since },
  ];
}
