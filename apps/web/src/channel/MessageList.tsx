// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { ChatMessage } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
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
    <li className="flex items-center gap-3 px-4 py-2 text-[12px] text-text-2">
      <hr className="flex-1 border-border-soft" />
      <span>{dayLabel(ts)}</span>
      <hr className="flex-1 border-border-soft" />
    </li>
  );
}

export function SystemLine({ text }: { text: string }) {
  return <li className="px-4 py-1.5 text-center text-[12px] text-text-2">{text}</li>;
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
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const target = params.get("m");
  const [lit, setLit] = useState<string | null>(null);
  const inList = !!target && v.top.some((m) => m.id === target);
  const replyRoot = useMemo(() => {
    if (!target || inList) return null;
    for (const [root, list] of v.replies) if (list.some((r) => r.id === target)) return root;
    return null;
  }, [target, inList, v.replies]);

  // A citation link: scroll to the message and mark it for 2 s; a thread reply opens its thread.
  useEffect(() => {
    if (replyRoot) navigate(`/c/${encodeURIComponent(chat.id)}/t/${encodeURIComponent(replyRoot)}`);
  }, [replyRoot, chat.id, navigate]);
  useEffect(() => {
    if (!target || !inList) return;
    stick.current = false;
    scroller.current
      ?.querySelector(`[data-message-id="${CSS.escape(target)}"]`)
      ?.scrollIntoView?.({ block: "center" });
    setLit(target);
    const t = setTimeout(() => setLit(null), 2000);
    return () => clearTimeout(t);
  }, [target, inList]);

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
        highlight={lit === m.id}
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
        <ul className="m-0 flex list-none flex-col p-0">{rows}</ul>
        <LiveStatus chatId={chat.id} chat={chat} />
      </div>
      <LiveAnnouncer chat={chat} />
    </div>
  );
}
