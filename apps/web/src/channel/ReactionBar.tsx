// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.

import { cn } from "../lib/cn";
import type { Reaction } from "../state/threads";

/** Reaction pills under a message; a click toggles your own reaction. */
export function ReactionBar({
  reactions,
  onToggle,
}: {
  reactions: Reaction[] | undefined;
  onToggle: (emoji: string, op: "add" | "remove") => void;
}) {
  if (!reactions || reactions.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          aria-pressed={r.mine}
          onClick={() => onToggle(r.emoji, r.mine ? "remove" : "add")}
          className={cn(
            "inline-flex cursor-pointer items-center gap-1 rounded-sm border px-1.5 py-px text-[12px] hover:bg-bg-2",
            r.mine ? "border-text-2 text-text-0" : "border-border-soft text-text-1",
          )}
        >
          {`${r.emoji} ${r.count}`}
        </button>
      ))}
    </div>
  );
}
