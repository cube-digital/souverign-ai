import { MAX_BLOB_BYTES } from "@sa/protocol";
import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";
import { Button } from "../ui/Button";

export function Composer({
  title,
  agentNames = [],
  onSendText,
  onSendFile,
}: {
  title: string;
  /** Names of the chat's agents, suggested after an `@`. */
  agentNames?: string[];
  onSendText: (text: string) => Promise<void>;
  onSendFile: (file: File) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const label = `Message # ${title}`;
  const mention = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(text);
  const suggestions = mention
    ? agentNames.filter((n) => n.toLowerCase().startsWith((mention[1] ?? "").toLowerCase()))
    : [];

  async function run(job: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await job();
    } catch {
      setError("Couldn't send. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    await run(async () => {
      try {
        await onSendText(t);
      } catch (err) {
        setText(t);
        throw err;
      }
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form onSubmit={submit} className="border-t border-line px-6 py-3.5">
      {error && (
        <p role="alert" className="mb-2 text-sm text-danger">
          {error}
        </p>
      )}
      {suggestions.length > 0 && (
        <ul aria-label="Agents in this chat" className="mb-2 flex flex-wrap gap-2">
          {suggestions.map((n) => (
            <li key={n}>
              <button
                type="button"
                onClick={() => setText((t) => t.replace(/@[\p{L}\p{N}_-]*$/u, `@${n} `))}
                className="cursor-pointer rounded-full border border-agent-line bg-teal-soft px-3 py-1 text-xs text-teal-text"
              >
                @{n}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2.5">
        <input
          ref={picker}
          type="file"
          data-testid="file-input"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.size > MAX_BLOB_BYTES) {
              setError("Files can be up to 10 MB.");
              return;
            }
            void run(() => onSendFile(file));
          }}
        />
        <Button
          aria-label="Attach a file"
          className="w-11 px-0"
          onClick={() => picker.current?.click()}
        >
          +
        </Button>
        <textarea
          aria-label={label}
          placeholder={`${label} · type @ to ask an agent`}
          rows={1}
          maxLength={8000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-32 min-h-[44px] min-w-0 flex-1 resize-none rounded-[10px] border border-line bg-panel px-3.5 py-2.5 text-text outline-none focus:border-teal"
        />
        <Button type="submit" variant="primary" disabled={busy || text.trim().length === 0}>
          Send
        </Button>
      </div>
    </form>
  );
}
