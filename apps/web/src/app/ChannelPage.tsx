import { useEffect } from "react";
import { useLocation, useParams } from "react-router";
import { ChannelHeader } from "../channel/ChannelHeader";
import { MessageList } from "../channel/MessageList";
import { TryThisCard } from "../channel/TryThisCard";
import { Composer } from "../composer/Composer";
import { EmptyState } from "../ds";
import { useSession } from "../state/session";
import { composeFrom } from "./compose";
import { useFollowOwnTurns } from "./followTurns";

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
      <Composer chat={chat} prefill={compose && { key: location.key, ...compose }} />
    </div>
  );
}
