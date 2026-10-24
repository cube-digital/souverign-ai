// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { type Agent, type Chat, MAX_BLOB_BYTES } from "@sa/protocol";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { agentsOutside, useWorkspaceAgents } from "../channel/shared";
import { Button, Icons } from "../ds";
import { addAgentWithKey } from "../state/membership";
import { useSession } from "../state/session";
import { AddAgentPrompt } from "./AddAgentPrompt";
import { loadDraft, saveDraft } from "./drafts";
import { type MentionOption, MentionPopover, mentionOptions } from "./MentionPopover";
import { SlashMenu, slashOptions } from "./SlashMenu";
import { expandSlash } from "./slash";

const MENTION_RE = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u;
const SLASH_RE = /^\/(\w*)$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Props = {
  chat: Chat;
  /** thread root id; the composer then replies in that thread */
  replyTo?: string | undefined;
  initial?: { text: string; quote?: string | undefined } | undefined;
  autoFocus?: boolean | undefined;
};

export function Composer(props: Props) {
  return <ComposerInner key={`${props.chat.id}|${props.replyTo ?? ""}`} {...props} />;
}

function ComposerInner({ chat, replyTo, initial, autoFocus }: Props) {
  const { user, engine, refreshChats } = useSession();
  const workspace = useWorkspaceAgents();
  const [text, setText] = useState(() => initial?.text ?? loadDraft(user.id, chat.id, replyTo));
  const [quote, setQuote] = useState(initial?.quote);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ text: string; agent: Agent } | null>(null);
  const [pick, setPick] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);

  const edit = (next: string) => {
    setText(next);
    setPick(0);
    setPending(null);
    saveDraft(user.id, chat.id, replyTo, next);
  };

  const mention = MENTION_RE.exec(text);
  const options = mention ? mentionOptions(chat, user.id, workspace, mention[1] ?? "") : [];
  const slash = SLASH_RE.exec(text);
  const commands = slash ? slashOptions(slash[1] ?? "") : [];

  const pickMention = (o: MentionOption) => edit(text.replace(/@[\p{L}\p{N}_-]*$/u, `@${o.name} `));
  const pickCommand = (name: string) => edit(`${name} `);

  async function send(out: string) {
    if (!engine) return;
    const body = quote ? `> ${quote.replace(/\s+/g, " ").slice(0, 200)}\n${out}` : out;
    setBusy(true);
    setError(null);
    try {
      await engine.sendText(chat.id, body, undefined, replyTo ? { replyTo } : undefined);
      setText("");
      setQuote(undefined);
      setPending(null);
      saveDraft(user.id, chat.id, replyTo, "");
    } catch {
      setError("Couldn't send. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const t = text.trim();
    if (!t || busy) return;
    let out = t;
    if (t.startsWith("/")) {
      const r = expandSlash(t, {
        inThread: replyTo !== undefined,
        agents: [
          ...chat.members
            .filter((m) => m.member_type === "agent")
            .map((m) => ({ name: m.display_name, inChat: true })),
          ...agentsOutside(chat, workspace).map((a) => ({ name: a.name, inChat: false })),
        ],
      });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      out = r.text;
    }
    const missing = agentsOutside(chat, workspace).find((a) =>
      new RegExp(`@${escapeRe(a.name)}(?![\\p{L}\\p{N}_-])`, "iu").test(out),
    );
    if (missing) {
      setError(null);
      setPending({ text: out, agent: missing });
      return;
    }
    await send(out);
  }

  async function addAndSend() {
    if (!pending || !engine) return;
    setBusy(true);
    setError(null);
    try {
      await addAgentWithKey({ engine, chat, refresh: refreshChats, agent: pending.agent });
    } catch {
      setError(`Couldn't add ${pending.agent.name}. Try again in a moment.`);
      setBusy(false);
      return;
    }
    setBusy(false);
    await send(pending.text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    const n = options.length > 0 ? options.length : commands.length;
    if (n > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const o = options[pick];
        const c = commands[pick];
        if (o) pickMention(o);
        else if (c) pickCommand(c.name);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  async function attach(file: File) {
    if (!engine) return;
    if (file.size > MAX_BLOB_BYTES) {
      setError("Files can be up to 10 MB.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await engine.sendFile(
        chat.id,
        { name: file.name, mime: file.type || "application/octet-stream", bytes },
        replyTo ? { replyTo } : undefined,
      );
    } catch {
      setError("Couldn't send the file. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  const label = replyTo ? "Reply in thread" : `Message # ${chat.title}`;
  return (
    <div className="border-t border-border-soft px-4 py-2">
      {error && (
        <p role="alert" className="mb-1 text-danger">
          {error}
        </p>
      )}
      {pending && (
        <AddAgentPrompt
          chat={chat}
          agent={pending.agent}
          userId={user.id}
          busy={busy}
          onAddAndSend={() => void addAndSend()}
          onSendWithout={() => void send(pending.text)}
          onCancel={() => setPending(null)}
        />
      )}
      {options.length > 0 ? (
        <MentionPopover options={options} index={pick} onPick={pickMention} />
      ) : (
        slash && <SlashMenu query={slash[1] ?? ""} index={pick} onPick={pickCommand} />
      )}
      {quote && (
        <p className="mb-1 flex items-center gap-2 border-l-2 border-border-strong pl-2 text-[12px] text-text-2">
          <span className="min-w-0 flex-1 truncate">{quote}</span>
          <button
            type="button"
            aria-label="Remove quote"
            onClick={() => setQuote(undefined)}
            className="cursor-pointer hover:text-text-0"
          >
            <Icons.X />
          </button>
        </p>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={picker}
          type="file"
          data-testid="file-input"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void attach(file);
          }}
        />
        <Button aria-label="Attach a file" onClick={() => picker.current?.click()}>
          <Icons.Plus />
        </Button>
        <textarea
          ref={area}
          aria-label={label}
          placeholder={`${label} · @ to tag, / for commands`}
          rows={1}
          maxLength={8000}
          value={text}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-32 min-h-8 min-w-0 flex-1 resize-none rounded-md border border-border-soft bg-bg-1 px-2.5 py-1.5 text-text-0 outline-none focus:border-border-strong"
        />
        <Button
          variant="primary"
          aria-label="Send"
          disabled={busy || text.trim().length === 0}
          onClick={() => void submit()}
        >
          <Icons.Send />
        </Button>
      </div>
    </div>
  );
}
