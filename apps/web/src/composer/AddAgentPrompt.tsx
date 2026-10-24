// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { Agent, Chat } from "@sa/protocol";
import { rosterEntry, TEMPLATE_INFO } from "@sa/protocol/roster";
import { Button, Card } from "../ds";

export function agentTools(agent: Agent): string[] {
  return rosterEntry(agent.roster_id)?.tools ?? TEMPLATE_INFO[agent.template]?.tools ?? [];
}

/** Whether this user may add the agent (the bridge lets any member add a workspace agent). */
export function canAddAgent(chat: Chat, agent: Agent, userId: string): boolean {
  if (agent.scope === "workspace") return true;
  const me = chat.members.find((m) => m.member_type === "user" && m.member_id === userId);
  return agent.owner_user_id === userId && me?.role === "owner";
}

/** Inline offer shown when a message tags an agent that is not in the chat. */
export function AddAgentPrompt({
  chat,
  agent,
  userId,
  busy,
  onAddAndSend,
  onSendWithout,
  onCancel,
}: {
  chat: Chat;
  agent: Agent;
  userId: string;
  busy: boolean;
  onAddAndSend: () => void;
  onSendWithout: () => void;
  onCancel: () => void;
}) {
  const allowed = canAddAgent(chat, agent, userId);
  const warning = rosterEntry(agent.roster_id)?.warning;
  const warn = warning && chat.seed_key !== warning.outside ? warning.text : null;
  return (
    <Card ai className="mb-2 flex flex-col gap-1.5">
      {allowed ? (
        <p className="text-text-0">{`Add ${agent.name} to this chat? It will see messages from now on.`}</p>
      ) : (
        <p className="text-text-0">Only the chat owner can add personal agents.</p>
      )}
      <p className="text-[12px] text-text-2">{`It can use: ${agentTools(agent).join(", ")}`}</p>
      {allowed && warn && <p className="text-[12px] text-warn-ink">{warn}</p>}
      <div className="flex gap-2">
        {allowed && (
          <Button size="sm" variant="primary" disabled={busy} onClick={onAddAndSend}>
            Add and send
          </Button>
        )}
        <Button size="sm" disabled={busy} onClick={onSendWithout}>
          Send without
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
