// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { ChatMessage } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { useEffect, useMemo, useRef } from "react";
import { useSession } from "../state/session";
import { LiveAnnouncer, LiveStatus } from "./LiveStatus";
import { MessageItem } from "./MessageItem";
import { useRowActions } from "./rowActions";
import { agentsOutside, useWorkspaceAgents } from "./shared";

const GROUP_MS = 5 * 60 * 1000;
const dayOf = (ts: number) => new Date(ts).toDateString();
const dayLabel = (ts: number) =>
  new Date(ts).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });

export function DayDivider({ ts }: { ts: number }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-[12px] text-text-2">
      <hr className="flex-1 border-border-soft" />
      <span>{dayLabel(ts)}</span>
      <hr className="flex-1 border-border-soft" />
    </div>
  );
}

export function SystemLine({ text }: { text: string }) {
  return <div className="px-4 py-1.5 text-center text-[12px] text-text-2">{text}</div>;
}

/** The top-level messages of a chat, grouped by sender and day. */
export function MessageList({ chat }: { chat: Chat }) {
  // Keyed by chat: scroll-follow state starts fresh in every chat.
  return <MessageListInner key={chat.id} chat={chat} />;
}

function MessageListInner({ chat }: { chat: Chat }) {
  const { view } = useSession();
  const v = view(chat.id);
  const workspace = useWorkspaceAgents();
  const others = useMemo(() => agentsOutside(chat, workspace), [chat, workspace]);
  const actions = useRowActions(chat.id);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the bottom when the content grows: new messages, streaming drafts, loading images.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const follow = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    follow();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(follow);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  let prev: ChatMessage | null = null;
  const rows = v.top.map((m) => {
    const newDay = !prev || dayOf(prev.ts) !== dayOf(m.ts);
    const divider = newDay ? <DayDivider key={`d-${m.id}`} ts={m.ts} /> : null;
    if (m.status === "ok" && m.body?.type === "system") {
      prev = m;
      return [divider, <SystemLine key={m.id} text={m.body.text} />];
    }
    const compact =
      !newDay &&
      prev !== null &&
      prev.senderDevice === m.senderDevice &&
      m.ts - prev.ts < GROUP_MS &&
      prev.body?.type !== "system";
    prev = m;
    return [
      divider,
      <MessageItem
        key={m.id}
        chat={chat}
        m={m}
        compact={compact}
        replies={v.replies.get(m.id)}
        reactions={v.reactions.get(m.id)}
        others={others}
        actions={actions}
      />,
    ];
  });

  return (
    <div
      ref={scroller}
      role="log"
      aria-live="off"
      aria-label={`Messages in # ${chat.title}`}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="flex min-h-0 flex-1 flex-col overflow-auto py-2"
    >
      <div ref={content} className="flex flex-col">
        {rows}
        <LiveStatus chatId={chat.id} chat={chat} />
      </div>
      <LiveAnnouncer chat={chat} />
    </div>
  );
}
