// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
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
  const trigger_ = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) trigger_.current?.focus();
  };
  const entries = () => [
    ...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  const onKeys = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const items = entries();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger_}
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
          ref={list}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeys}
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
              tabIndex={-1}
              onClick={() => {
                close(true);
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
