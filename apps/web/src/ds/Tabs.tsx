// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { cn } from "../lib/cn";

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border-soft">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
          className={cn(
            "-mb-px h-7 cursor-pointer border-b px-2.5 text-[13px]",
            t.id === value
              ? "border-text-0 font-semibold text-text-0"
              : "border-transparent text-text-2 hover:text-text-0",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
