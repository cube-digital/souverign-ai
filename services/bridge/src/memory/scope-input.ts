import { isShareGateActive } from "../agents/turn-hooks.js";
import type { Db } from "../db.js";
import type { ScopeInput, SharedChat } from "./scopes.js";
import { oneToOneHuman } from "./scopes.js";
import { usedTaught } from "./turn-recalls.js";

type AgentRow = {
  scope: "personal" | "workspace";
  owner_user_id: string | null;
  share_private_in_chats: "always" | "ask" | "never";
};

/** Loads the facts the D-9/D-13 scope builder needs. Null when the agent or chat is missing. */
export async function loadScopeInput(
  db: Db,
  agentId: string,
  chatId: string,
  opts: { noTaught: boolean; requesterUserId: string | null },
): Promise<ScopeInput | null> {
  const [agent] = await db.query<AgentRow>(
    "select scope, owner_user_id, share_private_in_chats from sa.agents where id = $1",
    [agentId],
  );
  const [chat] = await db.query<{ kind: "dm" | "group" | "room" }>(
    "select kind from sa.chats where id = $1",
    [chatId],
  );
  if (!agent || !chat) return null;

  const members = await db.query<{ member_type: string; member_id: string; joined_ms: string }>(
    `select m.member_type, m.member_id,
            (extract(epoch from m.joined_at) * 1000)::float8::text as joined_ms
       from sa.chat_members m
      where m.chat_id = $1 and m.removed_at is null`,
    [chatId],
  );
  const humans = members.filter((m) => m.member_type === "user").map((m) => m.member_id);
  const agents = members.filter((m) => m.member_type === "agent").map((m) => m.member_id);
  const self = members.find((m) => m.member_type === "agent" && m.member_id === agentId);

  const scopeAgent = {
    id: agentId,
    scope: agent.scope,
    ownerUserId: agent.owner_user_id,
    share: agent.share_private_in_chats,
  };
  const scopeChat = {
    id: chatId,
    kind: chat.kind,
    agentJoinedAt: self ? Number(self.joined_ms) : null,
    requesterJoinedAt: null as number | null,
    humans,
    agents,
  };

  let shared: SharedChat[] = [];
  const human = oneToOneHuman(scopeAgent, scopeChat);
  const requester = human ?? opts.requesterUserId;
  const reqMember = members.find((m) => m.member_type === "user" && m.member_id === requester);
  if (reqMember) scopeChat.requesterJoinedAt = Number(reqMember.joined_ms);
  else {
    // Fail closed: no (active) requester, so bound by the latest active human join.
    const joins = members.filter((m) => m.member_type === "user").map((m) => Number(m.joined_ms));
    if (joins.length > 0) scopeChat.requesterJoinedAt = Math.max(...joins);
  }
  if (human) {
    const rows = await db.query<{
      id: string;
      joined_ms: string;
      human_ms: string;
    }>(
      `select a.chat_id as id, (extract(epoch from a.joined_at) * 1000)::float8::text as joined_ms,
              (extract(epoch from h.joined_at) * 1000)::float8::text as human_ms
         from sa.chat_members a
         join sa.chat_members h on h.chat_id = a.chat_id
        where a.member_type = 'agent' and a.member_id = $1 and a.removed_at is null
          and h.member_type = 'user' and h.member_id = $2 and h.removed_at is null`,
      [agentId, human],
    );
    shared = rows.map((r) => ({
      id: r.id,
      agentJoinedAt: Number(r.joined_ms),
      requesterJoinedAt: Number(r.human_ms),
    }));
  }

  return {
    agent: scopeAgent,
    chat: scopeChat,
    shared,
    noTaught: opts.noTaught,
    // No share gate, no one to approve: `ask` fails closed instead of answering unchecked.
    approverAvailable:
      isShareGateActive() && (agent.scope === "personal" || opts.requesterUserId !== null),
  };
}

type TurnRef = {
  turnId: string;
  agentId: string;
  chatId: string;
  noTaught: boolean;
  requesterUserId: string | null;
};

/**
 * D-9: the turn recalled taught knowledge in a shared chat whose policy is not `always`, so no
 * model-written text may leave the turn before the share gate has seen it. Fails closed.
 */
export async function taughtHeld(db: Db, turn: TurnRef): Promise<boolean> {
  if (!usedTaught(turn.turnId, turn.agentId)) return false;
  const inp = await loadScopeInput(db, turn.agentId, turn.chatId, {
    noTaught: turn.noTaught,
    requesterUserId: turn.requesterUserId,
  });
  if (!inp) return true;
  if (oneToOneHuman(inp.agent, inp.chat) !== null) return false;
  return inp.agent.share !== "always";
}
