// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "rounded-sm border border-border-soft bg-bg-2 px-1 font-mono text-[10px] text-text-2",
        className,
      )}
      {...rest}
    />
  );
}
