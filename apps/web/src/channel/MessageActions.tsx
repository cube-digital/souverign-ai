// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { Agent, Chat } from "@sa/protocol";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { IconButton, Icons, Menu } from "../ds";
import type { RowActions } from "./rowActions";

const QUICK = ["👍", "✅", "👀", "❤️"];

/** The hover toolbar of a message: one tab stop, arrow keys move inside it, always visible on touch. */
export function MessageActions({
  chat,
  messageId,
  threadRoot,
  text,
  others,
  actions,
}: {
  chat: Chat;
  messageId: string;
  /** set inside a thread: asking an agent targets the thread, not the reply */
  threadRoot: string | undefined;
  /** the message text, quoted when asking an agent */
  text: string;
  /** agents that are not in the chat */
  others: Agent[];
  actions: RowActions;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const buttons = () => [
    ...(bar.current?.querySelectorAll<HTMLElement>('button:not([role="menuitem"])') ?? []),
  ];
  useLayoutEffect(() => {
    buttons().forEach((b, i) => {
      b.tabIndex = i === active ? 0 : -1;
    });
  });
  const onKeyDown = (e: KeyboardEvent) => {
    const list = buttons();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (
      at < 0 ||
      (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End")
    )
      return;
    e.preventDefault();
    const to =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? list.length - 1
          : (at + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
    setActive(to);
    list[to]?.focus();
  };
  const items = [
    ...chat.members.filter((m) => m.member_type === "agent").map((m) => m.display_name),
    ...others.map((a) => a.name),
  ].map((name) => ({
    label: name,
    onSelect: () => actions.ask(threadRoot ?? messageId, name, text),
  }));
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label="Message actions"
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        const i = buttons().indexOf(e.target as HTMLElement);
        if (i >= 0) setActive(i);
      }}
      className="absolute -top-3 right-2 z-10 flex items-center gap-0.5 rounded-md border border-border-soft bg-bg-1 px-1 py-0.5 opacity-0 shadow-[var(--shadow-1)] focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
    >
      {QUICK.map((e) => (
        <IconButton
          key={e}
          label={`React with ${e}`}
          onClick={() => actions.react(messageId, e, "add")}
        >
          {e}
        </IconButton>
      ))}
      {threadRoot === undefined && (
        <IconButton label="Reply in thread" onClick={() => actions.openThread(messageId)}>
          <Icons.Reply />
        </IconButton>
      )}
      {items.length > 0 && (
        <Menu label="Ask an agent…" trigger={<span>Ask an agent…</span>} items={items} />
      )}
      <IconButton
        label={copied ? "Copied" : "Copy text"}
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Icons.Check /> : <span aria-hidden="true">⧉</span>}
      </IconButton>
    </div>
  );
}
