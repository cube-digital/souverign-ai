import { useEffect, useRef } from "react";
import { useLocation, useParams } from "react-router";
import { ApprovalCard } from "../approvals/ApprovalCard";
import { useChatApprovals, useLoadAllApprovals } from "../approvals/store";
import { ChannelHeader } from "../channel/ChannelHeader";
import { MessageList } from "../channel/MessageList";
import { TryThisCard } from "../channel/TryThisCard";
import { Composer } from "../composer/Composer";
import { EmptyState } from "../ds";
import { useSession } from "../state/session";
import { composeFrom } from "./compose";
import { useFollowOwnTurns } from "./followTurns";

/** Call notes wait for approval in the inviter's DM with Scribe; no message carries their card. */
export function NotesApprovals({ chatId }: { chatId: string }) {
  const list = useChatApprovals(chatId, "call_notes_publish");
  const loadAll = useLoadAllApprovals();
  useEffect(() => loadAll(), [loadAll]);
  // a request stays on screen once decided, but an old decided one is not brought back
  const seen = useRef(new Set<string>());
  for (const a of list) if (a.status === "pending") seen.current.add(a.id);
  const shown = list.filter((a) => seen.current.has(a.id));
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-4 py-2">
      {shown.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
    </div>
  );
}

/** One channel: header, the Try this card (in #general), messages, live status and the composer. */
export function ChannelPage() {
  const { chatId = "", rootId } = useParams();
  const { chats, phase, openChat } = useSession();
  const location = useLocation();
  const chat = chats.find((c) => c.id === chatId);
  const id = chat?.id ?? null;

  useEffect(() => openChat(id), [id, openChat]);
  useFollowOwnTurns(id);

  if (!chat) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState>
          {phase === "ready" ? "This chat is not available." : "Loading chat…"}
        </EmptyState>
      </div>
    );
  }
  // "Ask an agent…" on a thread lands on /t/:rootId; the thread composer takes that text, not this one.
  const compose = rootId ? undefined : composeFrom(location);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChannelHeader chat={chat} />
      <TryThisCard chat={chat} />
      <MessageList chat={chat} />
      <NotesApprovals chatId={chat.id} />
      <Composer chat={chat} prefill={compose && { key: location.key, ...compose }} />
    </div>
  );
}
