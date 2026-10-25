// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { Chat } from "@sa/protocol";
import { Avatar, Button, Icons } from "../ds";
import { useRail } from "../shell/rail";
import { AgentStatusChip } from "./AgentMessage";

/** Title, topic, members and the rail buttons of a chat. */
export function ChannelHeader({ chat }: { chat: Chat }) {
  const rail = useRail();
  const people = chat.members.filter((m) => m.member_type === "user");
  const agents = chat.members.filter((m) => m.member_type === "agent");
  const relayOpen = rail.panel?.kind === "relay";
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border-soft px-4 py-2">
      <div className="min-w-0 flex-1 basis-60">
        <h1 className="flex items-center gap-1 text-[15px] font-semibold text-text-0">
          <Icons.Hash />
          <span className="truncate">{chat.title}</span>
        </h1>
        {chat.topic && <p className="truncate text-[12px] text-text-2">{chat.topic}</p>}
      </div>
      <div className="flex items-center gap-1">
        {people.slice(0, 5).map((p) => (
          <span key={p.member_id} title={p.display_name}>
            <Avatar name={p.display_name} size={20} />
          </span>
        ))}
      </div>
      <ul className="flex flex-wrap items-center gap-2 text-[12px] text-text-1">
        {agents.map((a) => (
          <li key={a.member_id} className="inline-flex items-center gap-1">
            <AgentStatusChip status={a.status} />
            {a.display_name}
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        aria-label="Members"
        onClick={() => rail.open({ kind: "members", chatId: chat.id })}
      >
        <Icons.Users />
        <span>{people.length + agents.length}</span>
      </Button>
      <Button size="sm" onClick={() => rail.open({ kind: "activity", chatId: chat.id })}>
        <Icons.Pulse />
        Activity
      </Button>
      <Button size="sm" onClick={() => rail.open({ kind: "notes", chatId: chat.id })}>
        Notes
      </Button>
      <Button
        size="sm"
        aria-pressed={relayOpen}
        onClick={() => (relayOpen ? rail.close() : rail.open({ kind: "relay", chatId: chat.id }))}
      >
        Relay
      </Button>
    </header>
  );
}
