// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { cn } from "../lib/cn";

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-4 w-7 shrink-0 cursor-pointer rounded-md border disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-text-0 bg-text-0" : "border-border-strong bg-bg-2",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0.5 h-2.5 w-2.5 rounded-sm",
          checked ? "left-[14px] bg-bg-0" : "left-0.5 bg-text-3",
        )}
      />
    </button>
  );
}
