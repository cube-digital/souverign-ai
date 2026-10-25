// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { type Agent, type Chat, MAX_BLOB_BYTES } from "@sa/protocol";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { agentsOutside, useWorkspaceAgents } from "../channel/shared";
import { Button, Icons } from "../ds";
import { onBridgeEvent } from "../lib/bridge-events";
import { addAgentWithKey } from "../state/membership";
import { useSession } from "../state/session";
import { firstAudio, markSent } from "../voice/latency";
import { PushToTalk } from "../voice/PushToTalk";
import type { Rec } from "../voice/recorder";
import { type VoiceChunk, VoicePlayer } from "../voice/voiceStream";
import { AddAgentPrompt, canAddAgent } from "./AddAgentPrompt";
import { loadDraft, saveDraft } from "./drafts";
import { type MentionOption, MentionPopover, mentionOptions } from "./MentionPopover";
import { SlashMenu, slashOptions } from "./SlashMenu";
import { expandSlash, SLASH_COMMANDS } from "./slash";

const MENTION_RE = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u;
const SLASH_RE = /^\/(\w*)$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type Prefill = { key: string; text: string; quote?: string | undefined };

type Props = {
  chat: Chat;
  /** thread root id; the composer then replies in that thread */
  replyTo?: string | undefined;
  /** applied at mount only */
  initial?: { text: string; quote?: string | undefined } | undefined;
  /** applied whenever `key` changes, e.g. the router location key after "Ask an agent…" */
  prefill?: Prefill | undefined;
  autoFocus?: boolean | undefined;
};

export function Composer(props: Props) {
  return <ComposerInner key={`${props.chat.id}|${props.replyTo ?? ""}`} {...props} />;
}

function ComposerInner({ chat, replyTo, initial, prefill, autoFocus }: Props) {
  const { user, engine, refreshChats } = useSession();
  const workspace = useWorkspaceAgents();
  const start = prefill ?? initial;
  const [text, setText] = useState(() => start?.text ?? loadDraft(user.id, chat.id, replyTo));
  const [quote, setQuote] = useState(start?.quote);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ text: string; agents: Agent[] } | null>(null);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const textRef = useRef(text);
  const lastPrefill = useRef(prefill?.key);
  const listId = useId();
  const players = useRef(new Map<string, VoicePlayer>());
  const early_ = useRef(new Map<string, VoiceChunk[]>());

  // The spoken answer to a voice message streams in as voice.chunk events for that message id.
  useEffect(() => {
    const map = players.current;
    const early = early_.current;
    const off = onBridgeEvent((ev) => {
      if (ev.type !== "voice.chunk" || ev.chat_id !== chat.id) return;
      const chunk = { seq: ev.seq, wav_b64: ev.wav_b64, text: ev.text };
      const player = map.get(ev.source_id);
      if (player) player.push(chunk);
      else if (early.size < 8 || early.has(ev.source_id)) {
        // the answer can beat sendFile's promise: keep the chunks until the player exists
        early.set(ev.source_id, [...(early.get(ev.source_id) ?? []), chunk]);
      }
    });
    return () => {
      off();
      for (const p of map.values()) p.stop();
      map.clear();
      early.clear();
    };
  }, [chat.id]);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);

  // A new prefill key (another "Ask an agent…") replaces the text, even while this composer stays mounted.
  useEffect(() => {
    if (!prefill || prefill.key === lastPrefill.current) return;
    lastPrefill.current = prefill.key;
    textRef.current = prefill.text;
    setText(prefill.text);
    setQuote(prefill.quote);
    setPending(null);
    setPick(0);
    setDismissed(false);
    saveDraft(user.id, chat.id, replyTo, prefill.text);
    area.current?.focus();
  }, [prefill, user.id, chat.id, replyTo]);

  const edit = (next: string) => {
    textRef.current = next;
    setText(next);
    setPick(0);
    setDismissed(false);
    setPending(null);
    saveDraft(user.id, chat.id, replyTo, next);
  };

  const mention = MENTION_RE.exec(text);
  const options =
    !dismissed && mention ? mentionOptions(chat, user.id, workspace, mention[1] ?? "") : [];
  const slash = SLASH_RE.exec(text);
  const commands = !dismissed && options.length === 0 && slash ? slashOptions(slash[1] ?? "") : [];
  const open = options.length > 0 || commands.length > 0;
  const count = options.length || commands.length;

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${pick}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, pick, listId]);

  const pickMention = (o: MentionOption) => edit(text.replace(/@[\p{L}\p{N}_-]*$/u, `@${o.name} `));
  const pickCommand = (name: string) => edit(`${name} `);

  /** `source` is the trimmed text that produced `out`; the box is cleared only if it still holds it. */
  async function send(out: string, source: string) {
    if (!engine) return;
    const body = quote ? `> ${quote.replace(/\s+/g, " ").slice(0, 200)}\n${out}` : out;
    setBusy(true);
    setError(null);
    try {
      await engine.sendText(chat.id, body, undefined, replyTo ? { replyTo } : undefined);
      setPending(null);
      setQuote(undefined);
      if (textRef.current.trim() === source) {
        textRef.current = "";
        setText("");
        saveDraft(user.id, chat.id, replyTo, "");
      }
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
    const missing = agentsOutside(chat, workspace).filter((a) =>
      new RegExp(`@${escapeRe(a.name)}(?![\\p{L}\\p{N}_-])`, "iu").test(out),
    );
    if (missing.length > 0) {
      setError(null);
      setPending({ text: out, agents: missing });
      return;
    }
    await send(out, t);
  }

  async function addAndSend() {
    if (!pending || !engine) return;
    const source = text.trim();
    setBusy(true);
    setError(null);
    for (const agent of pending.agents.filter((a) => canAddAgent(chat, a, user.id))) {
      try {
        await addAgentWithKey({ engine, chat, refresh: refreshChats, agent });
      } catch {
        setError(`Couldn't add ${agent.name}. Try again in a moment.`);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    await send(pending.text, source);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing || e.key === "Process") return;
    if (open) {
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((i) => (i + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const o = options[pick];
        const c = commands[pick];
        const def = SLASH_COMMANDS.find((x) => x.name === c?.name);
        // A complete command that takes no argument is sent straight away.
        if (e.key === "Enter" && c && def && !def.arg && text.trim() === c.name) {
          e.preventDefault();
          void submit();
          return;
        }
        e.preventDefault();
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

  async function sendVoice(rec: Rec) {
    if (!engine) return;
    const releasedAt = Date.now();
    setError(null);
    try {
      const ext = rec.mime.includes("mp4") || rec.mime.includes("m4a") ? "m4a" : "webm";
      const id = await engine.sendFile(
        chat.id,
        { name: `voice-${releasedAt}.${ext}`, mime: rec.mime, bytes: rec.bytes },
        { voice: { duration_ms: rec.durationMs }, ...(replyTo ? { replyTo } : {}) },
      );
      markSent(id, releasedAt);
      players.current.get(id)?.stop();
      const player = new VoicePlayer(id, { onFirstAudio: () => void firstAudio(id, Date.now()) });
      players.current.set(id, player);
      for (const c of early_.current.get(id) ?? []) player.push(c);
      early_.current.delete(id);
    } catch {
      setError("Couldn't send the voice message. Try again in a moment.");
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
      <div role="status" aria-live="polite" className="sr-only">
        {open ? `${count} suggestion${count === 1 ? "" : "s"}` : ""}
      </div>
      {pending && (
        <AddAgentPrompt
          chat={chat}
          agents={pending.agents}
          userId={user.id}
          busy={busy}
          onAddAndSend={() => void addAndSend()}
          onSendWithout={() => void send(pending.text, text.trim())}
          onCancel={() => setPending(null)}
        />
      )}
      {options.length > 0 && (
        <MentionPopover options={options} index={pick} listId={listId} onPick={pickMention} />
      )}
      {commands.length > 0 && (
        <SlashMenu query={slash?.[1] ?? ""} index={pick} listId={listId} onPick={pickCommand} />
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
        {/* Stays a textbox for assistive tech and tests: the list is tied to it with aria-controls. */}
        <textarea
          ref={area}
          aria-label={label}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${pick}` : undefined}
          placeholder={`${label} · @ to tag, / for commands`}
          rows={1}
          maxLength={8000}
          value={text}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-32 min-h-8 min-w-0 flex-1 resize-none rounded-md border border-border-soft bg-bg-1 px-2.5 py-1.5 text-[13px] text-text-0 outline-none placeholder:text-text-3 focus:border-border-strong focus-visible:ring-2 focus-visible:ring-ai"
        />
        {text.trim().length === 0 ? (
          <PushToTalk onSend={(r) => void sendVoice(r)} disabled={busy || !engine} />
        ) : (
          <Button variant="primary" aria-label="Send" disabled={busy} onClick={() => void submit()}>
            <Icons.Send />
          </Button>
        )}
      </div>
    </div>
  );
}
