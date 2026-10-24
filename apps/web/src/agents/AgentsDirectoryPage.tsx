import type { Agent } from "@sa/protocol";
import { ROSTER } from "@sa/protocol/roster";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { agentDm, agents as fetchAgents } from "../api";
import { Button, EmptyState } from "../ds";
import { addAgentWithKey } from "../state/membership";
import { useSession } from "../state/session";
import { AgentCard } from "./AgentCard";
import { CreateAgentDialog } from "./CreateAgentDialog";

export function AgentsDirectoryPage() {
  const { chats, engine, refreshChats } = useSession();
  const navigate = useNavigate();
  const [list, setList] = useState<Agent[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await fetchAgents());
    } catch {
      setError("Couldn't load agents.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const workspace = ROSTER.flatMap((r) => {
    const a = list.find((x) => x.roster_id === r.id);
    return a ? [a] : [];
  });
  const personal = list.filter((a) => a.owner_user_id !== null && !a.roster_id);

  const targets = (a: Agent) =>
    chats
      .filter((c) => !c.members.some((m) => m.member_type === "agent" && m.member_id === a.id))
      .map((c) => ({ id: c.id, title: c.title }));

  async function message(a: Agent) {
    try {
      const dm = await agentDm(a.id);
      navigate(`/c/${encodeURIComponent(dm.id)}`);
    } catch {
      setError(`Couldn't open a chat with ${a.name}.`);
    }
  }
  async function add(a: Agent, chatId: string) {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return;
    try {
      await addAgentWithKey({
        engine: engine as never,
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
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
      <section aria-label="Workspace agents" className="flex flex-col gap-2">
        <h1 className="text-[15px] font-semibold text-text-0">Workspace agents</h1>
        <div className="grid gap-3 sm:grid-cols-2">{workspace.map(card)}</div>
      </section>
      <section aria-label="Your agents" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-text-0">Your agents</h2>
          <Button size="sm" onClick={() => setCreating(true)}>
            + New agent
          </Button>
        </div>
        {personal.length === 0 && <EmptyState>You have no agents yet.</EmptyState>}
        <div className="grid gap-3 sm:grid-cols-2">{personal.map(card)}</div>
      </section>
      {creating && (
        <CreateAgentDialog
          onClose={() => setCreating(false)}
          onCreated={(a) => {
            setCreating(false);
            setList((l) => [...l, a]);
          }}
        />
      )}
    </div>
  );
}
