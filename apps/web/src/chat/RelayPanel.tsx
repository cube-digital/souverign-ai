import type { RelayRecentRow } from "@sa/protocol";
import { useEffect, useState } from "react";
import { formatSize, shortId, timeOf } from "../lib/format";
import { useSession } from "../state/session";

export function RelayPanel() {
  const [rows, setRows] = useState<RelayRecentRow[]>([]);
  const { ticket, deviceId } = useSession();

  useEffect(() => {
    if (!deviceId) return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/relay/debug/recent?limit=50", {
          headers: { Authorization: `Bearer ${await ticket()}` },
        });
        if (res.ok && alive) setRows((await res.json()) as RelayRecentRow[]);
      } catch {
        // relay unreachable: keep the last rows
      }
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ticket, deviceId]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3.5 p-4">
      <div>
        <h2 className="text-[15px] font-semibold">What the relay sees</h2>
        <p className="mt-1 text-xs text-muted">
          Ids, sizes and times. Never a key, never the text.
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {[...rows]
          .sort((a, b) => b.seq - a.seq)
          .map((r) => (
            <div
              key={r.seq}
              data-testid="relay-row"
              className="rounded-[10px] border border-line bg-bg px-3 py-2.5"
            >
              <div className="flex justify-between text-xs text-muted">
                <span>
                  {timeOf(r.ts, true)} · {r.kind}
                </span>
                <span>{formatSize(r.size)}</span>
              </div>
              <div className="mt-1 font-mono text-xs text-soft">
                chat {shortId(r.chat_id)} · dev {shortId(r.sender_device)}
              </div>
              <div className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-[#7c8597]">
                {r.ciphertext_prefix}…
              </div>
            </div>
          ))}
        {rows.length === 0 && <p className="text-xs text-muted">Nothing has passed through yet.</p>}
      </div>
    </div>
  );
}
