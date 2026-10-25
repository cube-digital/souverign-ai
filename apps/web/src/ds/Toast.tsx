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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const push = useCallback((text: string, tone: ToastTone = "info", action?: ToastAction) => {
    const id = next.current++;
    setItems((prev) => [...prev, { id, text, tone, action }]);
    const t = setTimeout(() => {
      timers.current.delete(t);
      setItems((prev) => prev.filter((i) => i.id !== id));
    }, LIFETIME_MS);
    timers.current.add(t);
  }, []);
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all) clearTimeout(t);
    };
  }, []);
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
          <div
            key={i.id}
            className={cn(
              "pointer-events-auto rounded-lg border bg-bg-1 px-3 py-2 text-[13px] shadow-[var(--shadow-2)]",
              i.tone === "error" ? "border-danger text-danger" : "border-border-soft text-text-0",
            )}
          >
            {i.text}
            {i.action && (
              <button
                type="button"
                onClick={i.action.onClick}
                className="ml-3 cursor-pointer underline"
              >
                {i.action.label}
              </button>
            )}
          </div>
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
