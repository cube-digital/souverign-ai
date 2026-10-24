// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { type ReactNode, useEffect, useId } from "react";
import { X } from "./Icons";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-full w-full max-w-md overflow-auto rounded-xl border border-border-soft bg-bg-1 p-4 shadow-[var(--shadow-2)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id={titleId} className="text-[15px] font-semibold text-text-0">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-text-2 hover:bg-bg-2 hover:text-text-0"
          >
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
