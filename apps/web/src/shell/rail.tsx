// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export type RailPanel =
  | { kind: "thread"; chatId: string; rootId: string }
  | { kind: "members" | "activity" | "relay"; chatId: string }
  | null;

type RailApi = { panel: RailPanel; open: (p: Exclude<RailPanel, null>) => void; close: () => void };

const Ctx = createContext<RailApi | null>(null);

export function RailProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<RailPanel>(null);
  const open = useCallback((p: Exclude<RailPanel, null>) => setPanel(p), []);
  const close = useCallback(() => setPanel(null), []);
  const value = useMemo(() => ({ panel, open, close }), [panel, open, close]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRail(): RailApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRail outside RailProvider");
  return v;
}
