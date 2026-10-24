import type { Agent } from "@sa/protocol";
import { AUTONOMY, rosterEntry, TEMPLATE_INFO } from "@sa/protocol/roster";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { AgentAvatar, Chip, StatusDot, Tabs } from "../ds";
import { openAgentDm } from "../state/agentDm";
import { useAgents } from "../state/agents";
import { useSession } from "../state/session";
import { ActivityTab } from "./ActivityTab";
import { RoutinesTab } from "./RoutinesTab";

type Tab = "overview" | "activity" | "routines";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "routines", label: "Routines" },
];

function Overview({ agent }: { agent: Agent }) {
  const session = useSession();
  const { chats, user } = session;
  const navigate = useNavigate();
  const entry = rosterEntry(agent.roster_id);
  const info = entry ?? TEMPLATE_INFO[agent.template] ?? { tools: [], examples: [] };
  const readFrom = chats.flatMap((c) => {
    if (!c.members.some((x) => x.member_type === "user" && x.member_id === user.id)) return [];
    const m = c.members.find((x) => x.member_type === "agent" && x.member_id === agent.id);
    if (!m) return [];
    const when = m.joined_at ? new Date(m.joined_at).toLocaleString() : "the start";
    return [{ id: c.id, text: `${c.title} · can read from ${when}` }];
  });
  async function open(prompt: string) {
    const dm = await openAgentDm(session, agent.id);
    navigate(`/c/${encodeURIComponent(dm.id)}`, { state: { compose: { text: prompt } } });
  }
  return (
    <div className="flex flex-col gap-4 text-[13px]">
      {entry && <p className="text-text-1">{entry.role}</p>}
      <div className="flex items-center gap-2">
        <Chip>{entry?.autonomy ?? AUTONOMY}</Chip>
        <StatusDot status={agent.status} />
        <span className="text-text-2">{agent.status}</span>
      </div>
      <section aria-label="Tools" className="flex flex-col gap-1">
        <h2 className="text-[12px] text-text-2">Tools</h2>
        <div className="flex flex-wrap gap-1">
          {info.tools.map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </div>
      </section>
      <section aria-label="Examples" className="flex flex-col gap-1">
        <h2 className="text-[12px] text-text-2">Try asking</h2>
        {info.examples.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => void open(e)}
            className="cursor-pointer text-left text-text-1 hover:text-text-0 hover:underline"
          >
            {e}
          </button>
        ))}
      </section>
      <section aria-label="Chats" className="flex flex-col gap-1">
        <h2 className="text-[12px] text-text-2">Chats it is in</h2>
        <ul className="flex flex-col gap-1">
          {readFrom.map((r) => (
            <li key={r.id} className="text-text-1">
              {r.text}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function AgentProfilePage() {
  const { agentId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { agents, failed } = useAgents();
  const agent =
    agents === null ? (failed ? null : undefined) : (agents.find((a) => a.id === agentId) ?? null);

  if (agent === undefined) return null;
  if (agent === null) return <p className="p-4 text-[13px] text-text-2">Agent not found.</p>;
  const raw = params.get("tab");
  const tab: Tab = TABS.some((t) => t.id === raw) ? (raw as Tab) : "overview";
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <AgentAvatar name={agent.name} id={agent.id} rosterId={agent.roster_id} size={32} />
        <h1 className="text-[15px] font-semibold text-text-0">{agent.name}</h1>
      </div>
      <Tabs
        tabs={TABS}
        value={tab}
        label="Agent"
        panelId="agent-panel"
        idPrefix="agent-tab"
        onChange={(id) => setParams(id === "overview" ? {} : { tab: id }, { replace: true })}
      />
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the tab panel is focusable per the ARIA tabs pattern */}
      <div role="tabpanel" id="agent-panel" aria-labelledby={`agent-tab-${tab}`} tabIndex={0}>
        {tab === "overview" && <Overview agent={agent} />}
        {tab === "activity" && <ActivityTab agent={agent} />}
        {tab === "routines" && <RoutinesTab agent={agent} />}
      </div>
    </div>
  );
}
