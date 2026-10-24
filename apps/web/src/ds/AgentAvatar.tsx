// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { ROSTER } from "@sa/protocol/roster";
import { cn } from "../lib/cn";

function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** An agent: a rounded square tinted with the roster hue. Personal agents hash their id for the hue. */
export function AgentAvatar({
  name,
  id,
  rosterId,
  size = 24,
  className,
}: {
  name: string;
  /** agent id; hashes the hue of personal agents */
  id?: string;
  rosterId?: string | null;
  size?: number;
  className?: string;
}) {
  const entry = rosterId ? ROSTER.find((r) => r.id === rosterId) : undefined;
  const glyph = entry?.glyph ?? name.trim().slice(0, 2).toUpperCase();
  const hue = entry?.hue ?? hueOf(id ?? name);
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.38)),
        background: `oklch(0.6 0.15 ${hue} / 0.18)`,
        borderColor: `oklch(0.6 0.15 ${hue} / 0.5)`,
        color: `oklch(0.55 0.17 ${hue})`,
      }}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-md border font-semibold",
        className,
      )}
    >
      {glyph}
    </span>
  );
}
