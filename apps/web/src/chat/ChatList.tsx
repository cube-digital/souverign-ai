import type { Chat } from "@sa/protocol";
import { useState } from "react";
import { Button } from "../ui/Button";

export function ChatList({
  chats,
  unread,
  activeId,
  publicKey,
  onSelect,
  onNew,
}: {
  chats: Chat[];
  unread: Record<string, number>;
  activeId: string | null;
  publicKey: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
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
            {(unread[c.id] ?? 0) > 0 && (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-teal px-1 text-xs font-semibold text-teal-ink">
                {unread[c.id]}
                <span className="sr-only"> unread</span>
              </span>
            )}
          </button>
        ))}
        {shown.length === 0 && <p className="px-2 text-muted">No chats yet.</p>}
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
