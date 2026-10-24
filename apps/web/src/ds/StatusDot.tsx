// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { cn } from "../lib/cn";

const TONE = {
  running: "bg-ok",
  starting: "bg-warn",
  error: "bg-danger",
  stopped: "bg-text-4",
} as const;

export function StatusDot({
  status,
  className,
}: {
  status: keyof typeof TONE;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={status}
      className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", TONE[status], className)}
    />
  );
}
