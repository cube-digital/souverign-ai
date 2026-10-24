// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { TextMeta } from "@sa/protocol";
import { useState } from "react";

export const receiptsLine = (meta: TextMeta): string => {
  const parts: string[] = [];
  if (meta.read !== undefined) parts.push(`Read ${meta.read} message${meta.read === 1 ? "" : "s"}`);
  if (meta.tools && meta.tools.length > 0) parts.push(meta.tools.join(", "));
  if (meta.model) parts.push(meta.model);
  if (meta.local) parts.push("local");
  if (meta.ms !== undefined) parts.push(`${(meta.ms / 1000).toFixed(1)} s`);
  return parts.join(" · ");
};

/** What the agent read and used for this answer; expands to every tool step. Reused by agent pages. */
export function ReceiptsFooter({ meta }: { meta: TextMeta }) {
  const [open, setOpen] = useState(false);
  const line = receiptsLine(meta);
  const steps = (meta.trace ?? []).filter((s) => s.kind === "tool");
  if (!line && !meta.stopped_by) return null;
  return (
    <div className="mt-2 text-[12px] text-text-2">
      {line && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="cursor-pointer text-left hover:text-text-0"
        >
          {line}
        </button>
      )}
      {meta.stopped_by && <p className="mt-0.5">{`Stopped by ${meta.stopped_by}`}</p>}
      {open && (
        <ol className="mt-1.5 flex flex-col gap-1.5">
          {steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the trace is fixed once sent
            <li key={i} className="rounded-md border border-border-soft bg-bg-0 px-2 py-1.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <strong className="font-mono font-medium text-text-1">{s.name}</strong>
                <span className="font-mono">{s.args}</span>
                <span className="ml-auto">{`${s.ms} ms`}</span>
              </div>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-text-1">
                {s.result}
              </pre>
            </li>
          ))}
          {steps.length === 0 && <li>No tool steps were recorded.</li>}
        </ol>
      )}
    </div>
  );
}
