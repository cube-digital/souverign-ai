import type { Agent } from "@sa/protocol";
import { useMemo } from "react";
import { ReceiptsFooter } from "../channel/ReceiptsFooter";
import { EmptyState } from "../ds";
import { useSession } from "../state/session";

const MAX = 20;

/** The agent's recent replies across loaded chats, newest first, with their receipts. */
export function ActivityTab({ agent }: { agent: Agent }) {
  const { chats, messages } = useSession();
  const title = (id: string) => chats.find((c) => c.id === id)?.title ?? "";
  const rows = useMemo(
    () =>
      Object.values(messages)
        .flat()
        .filter(
          (m) => m.senderDevice === agent.device_id && m.status === "ok" && m.body?.type === "text",
        )
        .sort((a, b) => b.ts - a.ts)
        .slice(0, MAX),
    [messages, agent.device_id],
  );
  if (rows.length === 0) return <EmptyState>No recent replies yet.</EmptyState>;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((m) => {
        const body = m.body?.type === "text" ? m.body : null;
        const meta = body?.meta;
        return (
          <li key={m.id} className="rounded-lg border border-border-soft p-2 text-[13px]">
            <p className="text-[12px] text-text-3">
              {`${title(m.chatId)} · ${new Date(m.ts).toLocaleString()}`}
            </p>
            <p className="line-clamp-3 whitespace-pre-wrap break-words text-text-1">{body?.text}</p>
            {meta && <ReceiptsFooter meta={meta} />}
          </li>
        );
      })}
    </ul>
  );
}
