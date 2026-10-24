import type { RelayRecentRow } from "@sa/protocol";
import { useEffect, useState } from "react";
import { SHARED_TICKET_KEY } from "../api";
import { formatSize, shortId, timeOf } from "../lib/format";
import { Pill } from "../ui/Pill";

const SLOTS = [1, 2, 3, 4];

/**
 * The strip has no session of its own: it reads the latest ticket a pane stored. Same-origin
 * iframes share this tab's sessionStorage, and the relay accepts a ticket of any device here. Without one it just shows nothing yet.
 */
function useRecent(): RelayRecentRow[] {
  const [rows, setRows] = useState<RelayRecentRow[]>([]);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const ticket = sessionStorage.getItem(SHARED_TICKET_KEY);
        if (!ticket) return;
        const res = await fetch("/relay/debug/recent?limit=3", {
          headers: { Authorization: `Bearer ${ticket}` },
        });
        if (res.ok && alive) setRows((await res.json()) as RelayRecentRow[]);
      } catch {
        // keep the last rows
      }
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return rows;
}

export function PresenterPage() {
  const rows = useRecent();
  const latest = [...rows].sort((a, b) => b.seq - a.seq).slice(0, 3);
  return (
    <div className="flex min-h-full flex-col bg-bg text-[13px] text-text">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-5 py-2.5">
        <span aria-hidden="true" className="inline-block h-5 w-5 rounded-[6px] bg-teal" />
        <h1 className="text-[15px] font-semibold">Presenter view</h1>
        <span className="text-muted">Four people, one Mac</span>
      </header>
      <main className="grid flex-1 grid-cols-2 gap-3.5 p-3.5">
        {SLOTS.map((n) => (
          <iframe
            key={n}
            src={`/?slot=${n}`}
            title={`User ${n}`}
            className="h-[calc(50vh-70px)] min-h-[360px] w-full rounded-[14px] border border-line bg-panel"
          />
        ))}
      </main>
      <footer className="flex flex-wrap gap-3.5 border-t border-line bg-panel px-5 py-3">
        <div className="min-w-0 flex-[2_1_520px]">
          <div className="mb-1 text-xs text-muted">Relay, live: ciphertext only</div>
          {latest.map((r) => (
            <div
              key={r.seq}
              data-testid="relay-strip-row"
              className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-[#7c8597]"
            >
              {timeOf(r.ts, true)} {r.kind} {shortId(r.chat_id)} {shortId(r.sender_device)}{" "}
              {formatSize(r.size)} {r.ciphertext_prefix}…
            </div>
          ))}
        </div>
        <div className="flex flex-[1_1_320px] flex-wrap content-center gap-2">
          <Pill tone="teal">All AI runs on this Mac</Pill>
        </div>
      </footer>
    </div>
  );
}
