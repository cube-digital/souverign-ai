// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn";

type ToastTone = "info" | "error";
type ToastAction = { label: string; onClick: () => void };
type ToastItem = { id: number; text: string; tone: ToastTone; action?: ToastAction | undefined };
type ToastApi = { push: (text: string, tone?: ToastTone, action?: ToastAction) => void };

const Ctx = createContext<ToastApi | null>(null);
const LIFETIME_MS = 4000;
const ACTION_LIFETIME_MS = 10_000;

function ToastRow({ item, onDone }: { item: ToastItem; onDone: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const { id, action } = item;
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => onDone(id), action ? ACTION_LIFETIME_MS : LIFETIME_MS);
    return () => clearTimeout(t);
  }, [paused, id, action, onDone]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only pause the timer
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        "pointer-events-auto rounded-lg border bg-bg-1 px-3 py-2 text-[13px] shadow-[var(--shadow-2)]",
        item.tone === "error" ? "border-danger text-danger" : "border-border-soft text-text-0",
      )}
    >
      <span>{item.text}</span>
      {action && (
        <button
          type="button"
          onClick={() => {
            action.onClick();
            onDone(id);
          }}
          className="ml-3 cursor-pointer rounded-sm underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(0);
  const push = useCallback((text: string, tone: ToastTone = "info", action?: ToastAction) => {
    const id = next.current++;
    setItems((prev) => [...prev, { id, text, tone, action }]);
  }, []);
  const done = useCallback((id: number) => setItems((prev) => prev.filter((i) => i.id !== id)), []);
  const api = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed right-3 bottom-3 z-50 flex flex-col gap-2"
      >
        {items.map((i) => (
          <ToastRow key={i.id} item={i} onDone={done} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}

/** Like useToast, but null outside a ToastProvider. */
export function useOptionalToast(): ToastApi | null {
  return useContext(Ctx);
}
