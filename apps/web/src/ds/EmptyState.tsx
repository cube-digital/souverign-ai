// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { ReactNode } from "react";

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-1 text-[12.5px] text-text-3">{children}</p>;
}
