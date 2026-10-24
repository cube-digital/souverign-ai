// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { Agent, Chat } from "@sa/protocol";
import { agentsOutside } from "../channel/shared";
import { StatusDot } from "../ds";
import { cn } from "../lib/cn";

export type MentionOption = {
  name: string;
  kind: "person" | "agent" | "outside";
  status?: "running" | "starting" | "error" | "stopped" | undefined;
};

/** People, then agents in the chat, then workspace agents outside it; filtered by the typed prefix. */
export function mentionOptions(
  chat: Chat,
  userId: string,
  workspace: Agent[],
  query: string,
): MentionOption[] {
  const q = query.toLowerCase();
  const all: MentionOption[] = [
    ...chat.members
      .filter((m) => m.member_type === "user" && m.member_id !== userId)
      .map((m) => ({ name: m.display_name, kind: "person" as const })),
    ...chat.members
      .filter((m) => m.member_type === "agent")
      .map((m) => ({ name: m.display_name, kind: "agent" as const, status: m.status })),
    ...agentsOutside(chat, workspace).map((a) => ({
      name: a.name,
      kind: "outside" as const,
      status: a.status,
    })),
  ];
  return all.filter((o) => o.name.toLowerCase().startsWith(q));
}

export function MentionPopover({
  options,
  index,
  onPick,
}: {
  options: MentionOption[];
  index: number;
  onPick: (o: MentionOption) => void;
}) {
  if (options.length === 0) return null;
  const firstOutside = options.findIndex((o) => o.kind === "outside");
  return (
    <ul
      aria-label="Mention"
      className="mb-1 max-h-56 overflow-auto rounded-lg border border-border-soft bg-bg-1 p-1 shadow-[var(--shadow-2)]"
    >
      {options.map((o, i) => (
        <li key={`${o.kind}-${o.name}`}>
          {i === firstOutside && (
            <div className="px-2 pt-1 text-[11px] text-text-2">not in this chat</div>
          )}
          <button
            type="button"
            tabIndex={-1}
            aria-current={i === index}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(o)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left",
              i === index && "bg-bg-2",
            )}
          >
            {o.status && <StatusDot status={o.status} />}
            <span className="text-text-0">{o.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
