import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApprovalCard } from "./ApprovalCard";
import { usePendingApprovals } from "./store";

/** Header pill counting the actions waiting for me; opens a popover of compact cards. */
export function PendingPill() {
  const pending = usePendingApprovals();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (pending.length === 0) return null;
  const n = pending.length;
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        className="h-6 cursor-pointer rounded-sm border border-ai-glow bg-ai-bg px-2 text-[12px] text-ai"
      >
        {n === 1 ? "1 action waiting for you" : `${n} actions waiting for you`}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Actions waiting for you"
          className="absolute right-0 z-20 mt-1 flex max-h-[70vh] w-[360px] flex-col gap-2 overflow-y-auto rounded-lg border border-border-soft bg-bg-0 p-2"
        >
          {pending.map((a) => (
            <div key={a.id} className="flex flex-col gap-1">
              <ApprovalCard approval={a} compact />
              {a.reply_to && (
                <Link
                  to={`/c/${encodeURIComponent(a.chat_id)}/t/${encodeURIComponent(a.reply_to)}`}
                  onClick={() => setOpen(false)}
                  className="text-[12px] text-text-1 underline"
                >
                  Open thread
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
