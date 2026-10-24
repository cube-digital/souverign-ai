// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export function Card({
  ai = false,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { ai?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-bg-1 p-3",
        ai ? "border-ai-glow bg-ai-bg" : "border-border-soft",
        className,
      )}
      {...rest}
    />
  );
}
