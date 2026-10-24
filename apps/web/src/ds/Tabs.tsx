// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { type KeyboardEvent, useId, useRef } from "react";
import { cn } from "../lib/cn";

/** Tabs with roving tabindex and arrow keys. The caller's panel carries `role="tabpanel"` and `id={panelId}`. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  panelId,
  idPrefix,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  panelId?: string;
  /** stable id prefix so a panel can reference its tab with aria-labelledby */
  idPrefix?: string;
}) {
  const auto = useId();
  const base = idPrefix ?? auto;
  const root = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const edge = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (!step && edge === null) return;
    e.preventDefault();
    const at = tabs.findIndex((t) => t.id === value);
    const to = edge ?? (at + step + tabs.length) % tabs.length;
    const next = tabs[to];
    if (!next) return;
    onChange(next.id);
    root.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };
  return (
    <div
      ref={root}
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
      className="flex gap-1 border-b border-border-soft"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`${base}-${t.id}`}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          aria-controls={panelId}
          tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
          className={cn(
            "-mb-px h-7 cursor-pointer border-b px-2.5 text-[13px]",
            t.id === value
              ? "border-text-0 font-semibold text-text-0"
              : "border-transparent text-text-2 hover:text-text-0",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
