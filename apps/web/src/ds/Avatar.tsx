// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { cn } from "../lib/cn";

/** A person: a monochrome circle with the initial. */
export function Avatar({
  name,
  size = 24,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.42)) }}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full border border-border-soft bg-bg-2 font-semibold text-text-1",
        className,
      )}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
