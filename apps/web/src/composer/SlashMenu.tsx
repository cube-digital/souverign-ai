// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { cn } from "../lib/cn";
import { SLASH_COMMANDS } from "./slash";

export const slashOptions = (query: string) =>
  SLASH_COMMANDS.filter((c) => c.name.startsWith(`/${query.toLowerCase()}`));

/** The five slash commands with hints; the composer drives the selection (combobox pattern). */
export function SlashMenu({
  query,
  index,
  listId,
  onPick,
}: {
  query: string;
  index: number;
  listId: string;
  onPick: (name: string) => void;
}) {
  const items = slashOptions(query);
  if (items.length === 0) return null;
  return (
    <div
      id={listId}
      role="listbox"
      aria-label="Commands"
      className="mb-1 rounded-lg border border-border-soft bg-bg-1 p-1 shadow-[var(--shadow-2)]"
    >
      {items.map((c, i) => (
        <div
          key={c.name}
          id={`${listId}-${i}`}
          role="option"
          tabIndex={-1}
          aria-selected={i === index}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c.name);
          }}
          className={cn(
            "flex cursor-pointer items-baseline gap-2 rounded-md border-l-2 border-transparent px-2 py-1",
            i === index && "border-ai bg-bg-3 ring-1 ring-inset ring-border-strong",
          )}
        >
          <span className="font-mono text-text-0">{c.name}</span>
          <span className="text-[12px] text-text-2">{c.hint}</span>
        </div>
      ))}
    </div>
  );
}
