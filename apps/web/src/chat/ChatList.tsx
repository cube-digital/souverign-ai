import type { Agent, Chat } from "@sa/protocol";
import { useState } from "react";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";

export function ChatList({
  chats,
  unread,
  typing = {},
  activeId,
  publicKey,
  onSelect,
  onNew,
  agents = [],
  agentsActive = false,
  onOpenAgents,
  onNewAgent,
}: {
  chats: Chat[];
  unread: Record<string, number>;
  /** Chats with live agent activity. */
  typing?: Record<string, boolean>;
  activeId: string | null;
  publicKey: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  agents?: Agent[];
  agentsActive?: boolean;
  onOpenAgents?: () => void;
  onNewAgent?: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = chats.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()));
  const fingerprint =
    publicKey
      ?.slice(0, 16)
      .match(/.{1,4}/g)
      ?.join(" ") ?? "";
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div>
        <label htmlFor="chat-search" className="sr-only">
          Search chats
        </label>
        <input
          id="chat-search"
          type="search"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-h-[40px] w-full rounded-[10px] border border-line bg-bg px-3 text-text outline-none focus:border-teal"
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        <div className="px-2 pb-1 text-xs text-muted">Chats</div>
        {shown.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-current={c.id === activeId}
            onClick={() => onSelect(c.id)}
            className={`flex min-h-[44px] cursor-pointer items-center justify-between rounded-[10px] px-3 text-left ${
              c.id === activeId
                ? "bg-[#1f2533] font-medium text-text"
                : "text-soft hover:bg-panel-2"
            }`}
          >
            <span>
              <span aria-hidden="true"># </span>
              <span>{c.title}</span>
            </span>
            {typing[c.id] && (
              <span
                role="img"
                aria-label="typing"
                title="typing"
                className="mr-2 ml-auto h-2 w-2 rounded-full bg-teal motion-safe:animate-pulse"
              />
            )}
            {(unread[c.id] ?? 0) > 0 && (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-teal px-1 text-xs font-semibold text-teal-ink">
                {unread[c.id]}
                <span className="sr-only"> unread</span>
              </span>
            )}
          </button>
        ))}
        {shown.length === 0 && <p className="px-2 text-muted">No chats yet.</p>}
        {onOpenAgents && (
          <section aria-label="My agents" className="mt-4 flex flex-col gap-1">
            <div className="px-2 pb-1 text-xs text-muted">My agents</div>
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                aria-current={agentsActive}
                onClick={onOpenAgents}
                className="flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-[10px] px-3 text-left text-soft hover:bg-panel-2"
              >
                <Avatar name={a.name} agent size={28} />
                <span className="flex-1">{a.name}</span>
                <span
                  role="img"
                  aria-label={a.status}
                  title={a.status}
                  className={`h-2 w-2 rounded-full ${a.status === "running" ? "bg-teal" : a.status === "error" ? "bg-danger" : a.status === "starting" ? "bg-amber" : "bg-[#5b6475]"}`}
                />
              </button>
            ))}
            <button
              type="button"
              onClick={onNewAgent}
              className="min-h-[44px] cursor-pointer rounded-[10px] border border-dashed border-[#343b48] px-3 text-left text-muted hover:text-text"
            >
              + New agent
            </button>
          </section>
        )}
      </div>
      <Button variant="primary" onClick={onNew}>
        New chat
      </Button>
      <div className="rounded-[10px] bg-bg p-3 text-xs text-muted">
        This device's key
        <br />
        <span className="font-mono text-soft">{fingerprint}</span>
      </div>
    </div>
  );
}
