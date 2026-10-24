// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "../lib/cn";

const BASE = "inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-[11px]";

/** A small label. Badges are never round; only status dots are. */
export function Chip({
  tone = "neutral",
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "ai" | "ok" | "warn" | "danger" }) {
  const tones = {
    neutral: "border-border-soft text-text-2",
    ai: "border-ai-glow bg-ai-bg text-ai",
    ok: "border-ok text-ok-ink",
    warn: "border-warn text-warn-ink",
    danger: "border-danger text-danger",
  } as const;
  return <span className={cn(BASE, tones[tone], className)} {...rest} />;
}

/** A clickable chip, for example an example prompt. */
export function ChipButton({
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(
        BASE,
        "cursor-pointer border-border-soft text-text-1 hover:bg-bg-2 hover:text-text-0",
        className,
      )}
      {...rest}
    />
  );
}
