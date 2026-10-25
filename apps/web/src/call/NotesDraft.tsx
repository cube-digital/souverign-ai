import type { CallNotes } from "@sa/protocol";
import Markdown from "react-markdown";
import { Link } from "react-router";

export function NotesDraft({ notes, chatId }: { notes: CallNotes | null; chatId: string }) {
  return (
    <section
      aria-label="Notes draft"
      className="flex flex-col gap-2 rounded-md border border-border-soft p-3"
    >
      <h2 className="text-[13px] font-semibold text-text-0">Notes so far · only you see this</h2>
      {notes ? (
        <>
          <div className="text-[13px] text-text-1">
            <Markdown>{notes.body_md}</Markdown>
          </div>
          {notes.final && (
            <p className="text-[12px] text-text-1">
              Final notes are waiting for your approval.{" "}
              <Link className="underline" to={`/c/${chatId}`}>
                Open approvals
              </Link>
            </p>
          )}
        </>
      ) : (
        <p className="text-[12px] text-text-2">Nothing was captured.</p>
      )}
    </section>
  );
}
