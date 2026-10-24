// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { RelayRecentRow } from "@sa/protocol";
import { useEffect, useState } from "react";
import { formatSize, shortId, timeOf } from "../lib/format";
import { useSession } from "../state/session";

/** What the relay can see of this chat: ids, sizes and times. Never text. */
export function RelayRail({ chatId }: { chatId: string }) {
  const [rows, setRows] = useState<RelayRecentRow[]>([]);
  const { ticket, deviceId } = useSession();

  useEffect(() => {
    if (!deviceId) return;
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
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
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ticket, deviceId]);

  const mine = rows.filter((r) => r.chat_id === chatId).sort((a, b) => b.seq - a.seq);
  return (
    <aside aria-label="What the relay sees" className="flex min-h-0 flex-col gap-3 p-3">
      <p className="text-[12px] text-text-2">Ids, sizes and times. Never a key, never the text.</p>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {mine.map((r) => (
          <div
            key={r.seq}
            data-testid="relay-row"
            className="rounded-md border border-border-soft bg-bg-1 px-3 py-2"
          >
            <div className="flex justify-between text-[12px] text-text-2">
              <span>
                {timeOf(r.ts, true)} · {r.kind}
              </span>
              <span>{formatSize(r.size)}</span>
            </div>
            <div className="mt-1 font-mono text-[12px] text-text-1">
              chat {shortId(r.chat_id)} · dev {shortId(r.sender_device)}
            </div>
            <div className="mt-0.5 truncate font-mono text-[12px] text-text-3">
              {r.ciphertext_prefix}…
            </div>
          </div>
        ))}
        {mine.length === 0 && (
          <p className="text-[12px] text-text-3">Nothing has passed through yet.</p>
        )}
      </div>
    </aside>
  );
}
