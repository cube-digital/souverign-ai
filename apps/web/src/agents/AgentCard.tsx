import type { Agent } from "@sa/protocol";
import { rosterEntry } from "@sa/protocol/roster";
import { Link } from "react-router";
import { AgentAvatar, Button, Card, Menu, StatusDot } from "../ds";

export type AddTarget = { id: string; title: string };

export function AgentCard({
  agent,
  targets,
  onMessage,
  onAdd,
}: {
  agent: Agent;
  /** my chats this agent is not in */
  targets: AddTarget[];
  onMessage: (agent: Agent) => void;
  onAdd: (agent: Agent, chatId: string) => void;
}) {
  const entry = rosterEntry(agent.roster_id);
  return (
    <Card ai role="region" aria-label={agent.name} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <AgentAvatar name={agent.name} id={agent.id} rosterId={agent.roster_id} size={28} />
        <div className="min-w-0 flex-1">
          <Link
            to={`/agents/${encodeURIComponent(agent.id)}`}
            className="text-[13px] font-semibold text-text-0 hover:underline"
          >
            {agent.name}
          </Link>
          {entry && <p className="text-[12px] text-text-2">{entry.role}</p>}
        </div>
        <StatusDot status={agent.status} />
      </div>
      {entry && <p className="text-[12px] text-text-3">Can see: {entry.sees}</p>}
      {entry && (
        <ul className="flex flex-col gap-1 text-[12px] text-text-1">
          {entry.examples.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onMessage(agent)}>
          Message
        </Button>
        {targets.length > 0 ? (
          <Menu
            label="Add to chat"
            trigger={<span className="text-[12px]">Add to chat</span>}
            align="left"
            items={targets.map((t) => ({ label: t.title, onSelect: () => onAdd(agent, t.id) }))}
          />
        ) : (
          <Button size="sm" variant="ghost" disabled>
            Add to chat
          </Button>
        )}
      </div>
    </Card>
  );
}
