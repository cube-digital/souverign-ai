// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { Agent, Chat } from "@sa/protocol";
import { useEffect } from "react";
import { AgentAvatar, Chip, EmptyState, IconButton, Icons, StatusDot } from "../ds";
import { cn } from "../lib/cn";
import { invalidateAgents, useAgents } from "../state/agents";
import { useSession } from "../state/session";

const POLL_MS = 15_000;
const ROW =
  "flex h-6 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-[13px] hover:bg-bg-2 hover:text-text-0";

function Group({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-2.5">
      <div className="mb-0.5 flex items-center justify-between px-2.5">
        <h3 className="text-[10px] uppercase tracking-[0.04em] text-text-3">{title}</h3>
        {action}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Badge({ count, mention }: { count: number; mention?: boolean }) {
  if (count <= 0) return null;
  return (
    <Chip tone="ai" className="ml-auto">
      {mention ? `@ ${count}` : count}
    </Chip>
  );
}

export function Sidebar({
  activeChatId,
  onOpenChat,
  onOpenAgent,
  onOpenAgents,
  onNewChat,
}: {
  activeChatId: string | null;
  onOpenChat: (chatId: string) => void;
  onOpenAgent: (agent: Agent) => void;
  onOpenAgents?: () => void;
  onNewChat: () => void;
}) {
  const { chats, unread, mentions } = useSession();
  const { agents } = useAgents();

  // status dots follow the agents' state, so the shared list is refreshed on a timer
  useEffect(() => {
    const t = setInterval(() => void invalidateAgents(), POLL_MS);
    return () => clearInterval(t);
  }, []);

  const channels = chats.filter((c) => c.kind === "room" || c.kind === "group");
  const dms = chats.filter((c) => c.kind === "dm");
  // agents with their own DM: listed under Agents too, with a name apart from their DM row
  const inDm = new Set(
    dms
      .filter((c) => c.members.filter((m) => m.member_type === "user").length === 1)
      .flatMap((c) => c.members.filter((m) => m.member_type === "agent").map((m) => m.member_id)),
  );
  const chatRow = (c: Chat, glyph: React.ReactNode) => (
    <button
      key={c.id}
      type="button"
      onClick={() => onOpenChat(c.id)}
      aria-current={c.id === activeChatId ? "true" : undefined}
      className={cn(ROW, c.id === activeChatId ? "bg-bg-3 text-text-0" : "text-text-1")}
    >
      {glyph}
      <span className="truncate">{c.title}</span>
      <Badge count={unread[c.id] ?? 0} mention={mentions?.[c.id] === true} />
    </button>
  );

  return (
    <nav aria-label="Chats" className="flex h-full min-h-0 flex-col overflow-auto py-2">
      <div className="flex h-7 items-center gap-2 px-2.5">
        <Icons.Lock className="text-text-3" />
        <span className="text-[13px] font-semibold text-text-0">Sovereign Agents</span>
      </div>
      <Group
        title="Channels"
        action={
          <IconButton label="New chat" onClick={onNewChat} className="h-4 w-4">
            <Icons.Plus width={12} height={12} />
          </IconButton>
        }
      >
        {channels.length === 0 && <EmptyState>No channels yet</EmptyState>}
        {channels.map((c) => chatRow(c, <Icons.Hash className="shrink-0 text-text-3" />))}
      </Group>
      <Group title="Direct messages">
        {dms.length === 0 && <EmptyState>No direct messages yet</EmptyState>}
        {dms.map((c) => chatRow(c, <Icons.Users className="shrink-0 text-text-3" />))}
      </Group>
      <Group
        title="Agents"
        action={
          onOpenAgents && (
            <IconButton label="All agents" onClick={onOpenAgents} className="h-4 w-4">
              <Icons.Users width={12} height={12} />
            </IconButton>
          )
        }
      >
        {agents?.length === 0 && <EmptyState>No agents yet</EmptyState>}
        {/* every agent is listed here, also one with its own DM (that row opens the DM, this one
            the agent); when both rows show the same name, this one is named apart for
            assistive tech */}
        {(agents ?? []).map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onOpenAgent(a)}
            aria-label={inDm.has(a.id) ? `Agent ${a.name}, ${a.status}` : undefined}
            className={cn(ROW, "text-text-1")}
          >
            <AgentAvatar name={a.name} id={a.id} rosterId={a.roster_id} size={16} />
            <span className="truncate">{a.name}</span>
            <StatusDot status={a.status} className="ml-auto" />
          </button>
        ))}
      </Group>
    </nav>
  );
}
