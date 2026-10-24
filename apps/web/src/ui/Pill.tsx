import type { ReactNode } from "react";

const tones = {
  teal: "bg-teal-soft text-teal-text border-agent-line",
  amber: "bg-amber-soft text-amber-text border-amber-line",
  neutral: "bg-panel-2 text-muted border-line",
} as const;

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof tones;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
