// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean };

/** A button that opens a small list of actions; closes on pick, outside click and Escape. */
export function Menu({
  label,
  trigger,
  items,
  align = "right",
}: {
  label: string;
  trigger: ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 text-text-1 hover:bg-bg-2 hover:text-text-0"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-30 mt-1 min-w-40 rounded-lg border border-border-soft bg-bg-1 p-1 shadow-[var(--shadow-2)]",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={cn(
                "block w-full cursor-pointer rounded-md px-2.5 py-1 text-left text-[13px] hover:bg-bg-2",
                it.danger ? "text-danger" : "text-text-1 hover:text-text-0",
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
