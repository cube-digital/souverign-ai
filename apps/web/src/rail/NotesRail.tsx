import type { Note } from "@sa/protocol";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { chatNotes } from "../api";
import { EmptyState } from "../ds";
import { timeOf } from "../lib/format";

/** Notes the agents saved in this chat; each body is cut to 4 lines. */
export function NotesRail({ chatId }: { chatId: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  useEffect(() => {
    let live = true;
    setNotes(null);
    chatNotes(chatId)
      .then((n) => live && setNotes(n))
      .catch(() => live && setNotes([]));
    return () => {
      live = false;
    };
  }, [chatId]);

  return (
    <section aria-label="Notes" className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
      {notes?.length === 0 && <EmptyState>No notes saved in this chat yet.</EmptyState>}
      <ul className="flex flex-col gap-3">
        {notes?.map((n) => (
          <li key={n.id} className="flex flex-col gap-1 text-[13px]">
            <div className="font-semibold text-text-0">{n.title}</div>
            <div className="text-[12px] text-text-2">{`${n.agent_name} · ${timeOf(n.created_at)}`}</div>
            <div className="line-clamp-4 text-text-1">
              <Markdown>{n.body_md}</Markdown>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
