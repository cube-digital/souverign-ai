// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { Agent, Chat } from "@sa/protocol";
import { rosterEntry, TEMPLATE_INFO } from "@sa/protocol/roster";
import { useEffect, useRef } from "react";
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

/** Why the user cannot add this agent, or null when they can. */
export function cannotAddNote(chat: Chat, agent: Agent, userId: string): string | null {
  if (canAddAgent(chat, agent, userId)) return null;
  if (agent.owner_user_id !== userId) {
    const owner = chat.members.find(
      (m) => m.member_type === "user" && m.member_id === agent.owner_user_id,
    );
    return `Only ${owner?.display_name ?? "its owner"} can add ${agent.name}, a personal agent.`;
  }
  return "Only the chat owner can add personal agents.";
}

/** Inline offer shown when a message tags agents that are not in the chat. */
export function AddAgentPrompt({
  chat,
  agents,
  userId,
  busy,
  onAddAndSend,
  onSendWithout,
  onCancel,
}: {
  chat: Chat;
  agents: Agent[];
  userId: string;
  busy: boolean;
  onAddAndSend: () => void;
  onSendWithout: () => void;
  onCancel: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  const addable = agents.filter((a) => canAddAgent(chat, a, userId));
  useEffect(() => {
    first.current?.focus();
  }, []);
  return (
    <Card ai role="status" className="mb-2 flex flex-col gap-2">
      {agents.map((agent) => {
        const note = cannotAddNote(chat, agent, userId);
        const warning = rosterEntry(agent.roster_id)?.warning;
        const warn = warning && chat.seed_key !== warning.outside ? warning.text : null;
        return (
          <div key={agent.id} className="flex flex-col gap-1">
            <p className="text-text-0">
              {note ?? `Add ${agent.name} to this chat? It will see messages from now on.`}
            </p>
            <p className="text-[12px] text-text-2">{`It can use: ${agentTools(agent).join(", ")}`}</p>
            {!note && warn && <p className="text-[12px] text-warn-ink">{warn}</p>}
          </div>
        );
      })}
      <div className="flex gap-2">
        {addable.length > 0 && (
          <Button ref={first} size="sm" variant="primary" disabled={busy} onClick={onAddAndSend}>
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
