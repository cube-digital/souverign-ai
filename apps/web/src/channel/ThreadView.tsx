// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { useSession } from "../state/session";
import { LiveStatus } from "./LiveStatus";
import { MessageItem } from "./MessageItem";
import { agentsOutside, useWorkspaceAgents } from "./shared";

/** A thread root, its replies and the live status of agents answering in it. */
export function ThreadView({ chatId, rootId }: { chatId: string; rootId: string }) {
  const { chats, view } = useSession();
  const chat = chats.find((c) => c.id === chatId);
  const workspace = useWorkspaceAgents();
  if (!chat) return null;
  const v = view(chatId);
  const root = v.top.find((m) => m.id === rootId);
  const others = agentsOutside(chat, workspace);
  const replies = v.replies.get(rootId) ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto py-2">
      {root ? (
        <MessageItem
          chat={chat}
          m={root}
          reactions={v.reactions.get(root.id)}
          others={others}
          rootId={rootId}
        />
      ) : (
        <p className="px-4 text-text-2">This thread's first message is not available.</p>
      )}
      <div className="my-1 px-4 text-[12px] text-text-2">
        {`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
      </div>
      {replies.map((m) => (
        <MessageItem
          key={m.id}
          chat={chat}
          m={m}
          reactions={v.reactions.get(m.id)}
          others={others}
          rootId={rootId}
        />
      ))}
      <LiveStatus chatId={chatId} rootId={rootId} chat={chat} />
    </div>
  );
}
