// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { useMemo } from "react";
import { useSession } from "../state/session";
import { LiveStatus } from "./LiveStatus";
import { MessageItem } from "./MessageItem";
import { useRowActions } from "./rowActions";
import { agentsOutside, useWorkspaceAgents } from "./shared";
import { isHiddenVoiceRow, voiceProps, voiceRows } from "./voiceRows";

/** A thread root, its replies and the live status of agents answering in it. */
export function ThreadView({ chatId, rootId }: { chatId: string; rootId: string }) {
  const { chats, view, deviceId } = useSession();
  const chat = chats.find((c) => c.id === chatId);
  const workspace = useWorkspaceAgents();
  const actions = useRowActions(chatId);
  const others = useMemo(() => (chat ? agentsOutside(chat, workspace) : []), [chat, workspace]);
  if (!chat) return null;
  const v = view(chatId);
  const root = v.top.find((m) => m.id === rootId);
  const allReplies = v.replies.get(rootId) ?? [];
  const vr = voiceRows(root ? [root, ...allReplies] : allReplies, deviceId);
  const replies = allReplies.filter((m) => !isHiddenVoiceRow(m, vr.audioIds));
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto py-2">
      <ul className="m-0 flex list-none flex-col p-0">
        {root ? (
          <MessageItem
            chat={chat}
            m={root}
            reactions={v.reactions.get(root.id)}
            others={others}
            actions={actions}
            rootId={rootId}
            {...voiceProps(root, vr)}
          />
        ) : (
          <li className="px-4 text-text-2">This thread's first message is not available.</li>
        )}
        <li className="my-1 px-4 text-[12px] text-text-2">
          {`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
        </li>
        {replies.map((m) => (
          <MessageItem
            key={m.id}
            chat={chat}
            m={m}
            reactions={v.reactions.get(m.id)}
            others={others}
            actions={actions}
            rootId={rootId}
            {...voiceProps(m, vr)}
          />
        ))}
      </ul>
      <LiveStatus chatId={chatId} rootId={rootId} chat={chat} />
    </div>
  );
}
