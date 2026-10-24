// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { cn } from "../lib/cn";
import { SLASH_COMMANDS } from "./slash";

export const slashOptions = (query: string) =>
  SLASH_COMMANDS.filter((c) => c.name.startsWith(`/${query.toLowerCase()}`));

/** The five slash commands with hints; the composer drives the selection. */
export function SlashMenu({
  query,
  index,
  onPick,
}: {
  query: string;
  index: number;
  onPick: (name: string) => void;
}) {
  const items = slashOptions(query);
  if (items.length === 0) return null;
  return (
    <ul
      aria-label="Commands"
      className="mb-1 rounded-lg border border-border-soft bg-bg-1 p-1 shadow-[var(--shadow-2)]"
    >
      {items.map((c, i) => (
        <li key={c.name}>
          <button
            type="button"
            tabIndex={-1}
            aria-current={i === index}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c.name)}
            className={cn(
              "flex w-full cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-left",
              i === index && "bg-bg-2",
            )}
          >
            <span className="font-mono text-text-0">{c.name}</span>
            <span className="text-[12px] text-text-2">{c.hint}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
