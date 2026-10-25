import type { Citation } from "@sa/protocol";
import { useNavigate } from "react-router";
import { cn } from "../lib/cn";

const GLYPH: Record<Citation["source_type"], string> = {
  message: "💬",
  file: "📎",
  doc: "📄",
  note: "📝",
  correction: "✎",
  meeting: "🎙",
};

const hrefOf = (c: Citation): string | null => {
  if (c.space === "chat" && c.chat_id)
    return `/c/${encodeURIComponent(c.chat_id)}${c.message_id ? `?m=${encodeURIComponent(c.message_id)}` : ""}`;
  if (c.space === "agent" && c.agent_id)
    return `/agents/${encodeURIComponent(c.agent_id)}?tab=knowledge${c.item_id ? `&item=${encodeURIComponent(c.item_id)}` : ""}`;
  return null;
};

/** The memory sources an answer read: cited ones solid, the others muted. */
export function CitationChips({ citations }: { citations: Citation[] }) {
  const navigate = useNavigate();
  const sorted = [...citations].sort((a, b) => a.n - b.n);
  return (
    <ul className="m-0 mt-2 flex list-none flex-wrap gap-1.5 p-0" aria-label="Sources">
      {sorted.map((c) => {
        const href = hrefOf(c);
        return (
          <li key={c.n}>
            <button
              type="button"
              title={c.cited ? (c.title ?? undefined) : "Read, not cited"}
              disabled={!href}
              onClick={() => href && navigate(href)}
              className={cn(
                "inline-flex max-w-[260px] cursor-pointer items-center gap-1 rounded-sm border px-1.5 py-px text-[11px] disabled:cursor-default",
                c.cited
                  ? "border-border-strong bg-bg-1 text-text-0 hover:bg-bg-2"
                  : "border-border-soft text-text-2 hover:text-text-0",
              )}
            >
              <span aria-hidden="true">{GLYPH[c.source_type]}</span>
              <span className="truncate">{`[${c.n}] ${c.title ?? "Untitled"}`}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
