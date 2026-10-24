import type { Agent } from "@sa/protocol";
import { ROSTER } from "@sa/protocol/roster";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button, EmptyState } from "../ds";
import { openAgentDm } from "../state/agentDm";
import { useAgents } from "../state/agents";
import { addAgentWithKey } from "../state/membership";
import { useSession } from "../state/session";
import { AgentCard } from "./AgentCard";
import { CreateAgentDialog } from "./CreateAgentDialog";

export function AgentsDirectoryPage() {
  const session = useSession();
  const { chats, engine, refreshChats, user } = session;
  const navigate = useNavigate();
  const { agents: list, failed, reload } = useAgents();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(failed ? "Couldn't load agents." : null);

  useEffect(() => {
    if (failed) setError("Couldn't load agents.");
  }, [failed]);

  const loaded = list ?? [];
  const workspace = ROSTER.flatMap((r) => {
    const a = loaded.find((x) => x.roster_id === r.id);
    return a ? [a] : [];
  });
  const personal = loaded.filter((a) => a.owner_user_id === user.id && !a.roster_id);

  const targets = (a: Agent) =>
    chats
      .filter((c) => !c.members.some((m) => m.member_type === "agent" && m.member_id === a.id))
      .map((c) => ({ id: c.id, title: c.title }));

  async function message(a: Agent) {
    try {
      const dm = await openAgentDm(session, a.id);
      navigate(`/c/${encodeURIComponent(dm.id)}`);
    } catch {
      setError(`Couldn't open a chat with ${a.name}.`);
    }
  }
  async function add(a: Agent, chatId: string) {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat || !engine) return;
    try {
      await addAgentWithKey({
        engine,
        chat,
        refresh: refreshChats,
        agent: a,
      });
    } catch {
      setError(`Couldn't add ${a.name} to ${chat.title}.`);
    }
  }

  const card = (a: Agent) => (
    <AgentCard key={a.id} agent={a} targets={targets(a)} onMessage={message} onAdd={add} />
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4">
      <h1 className="text-[15px] font-semibold text-text-0">Agents</h1>
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
      <section aria-label="Workspace agents" className="flex flex-col gap-2">
        <h2 className="text-[15px] font-semibold text-text-0">Workspace agents</h2>
        <div className="grid gap-3 sm:grid-cols-2">{workspace.map(card)}</div>
      </section>
      <section aria-label="Your agents" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-text-0">Your agents</h2>
          <Button size="sm" onClick={() => setCreating(true)}>
            + New agent
          </Button>
        </div>
        {list === null && !error && <EmptyState>Loading agents…</EmptyState>}
        {list !== null && personal.length === 0 && <EmptyState>You have no agents yet.</EmptyState>}
        <div className="grid gap-3 sm:grid-cols-2">{personal.map(card)}</div>
      </section>
      {creating && (
        <CreateAgentDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}
