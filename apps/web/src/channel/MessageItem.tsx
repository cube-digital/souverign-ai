// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { ChatMessage } from "@sa/client";
import type { Agent, Chat, MessageBody } from "@sa/protocol";
import { memo, useState } from "react";
import { Avatar, Button } from "../ds";
import { formatSize, timeOf } from "../lib/format";
import type { Reaction } from "../state/threads";
import { AgentMessage } from "./AgentMessage";
import { ImagePreview } from "./ImagePreview";
import { WorkingBadge } from "./LiveStatus";
import { MessageActions } from "./MessageActions";
import { ReactionBar } from "./ReactionBar";
import type { RowActions } from "./rowActions";
import { ago, memberOfDevice } from "./shared";

type FileBody = Extract<MessageBody, { type: "file" }>;
const URL_RE = /(https?:\/\/[^\s<]+)/g;

function LinkedText({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-text-0">
      {text.split(URL_RE).map((part, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: split parts keep their position
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </p>
  );
}

function FileBlock({ body, actions }: { body: FileBody; actions: RowActions }) {
  const [failed, setFailed] = useState(false);
  async function download() {
    setFailed(false);
    try {
      const bytes = await actions.download(body);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: body.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = body.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    }
  }
  if (body.mime.startsWith("image/"))
    return <ImagePreview body={body} onDownload={actions.download} />;
  return (
    <div className="mt-1 inline-flex flex-wrap items-center gap-2 rounded-md border border-border-soft bg-bg-1 px-2.5 py-1.5">
      <span className="text-text-1">{body.name}</span>
      <span className="text-[12px] text-text-2">{formatSize(body.size)}</span>
      <Button size="sm" onClick={() => void download()}>
        Download
      </Button>
      {failed && <span className="text-[12px] text-danger">Download failed</span>}
    </div>
  );
}

export type MessageItemProps = {
  chat: Chat;
  m: ChatMessage;
  compact?: boolean;
  replies?: ChatMessage[] | undefined;
  reactions?: Reaction[] | undefined;
  /** workspace agents outside the chat, for "Ask an agent…" */
  others: Agent[];
  /** set inside a thread view */
  rootId?: string | undefined;
  actions: RowActions;
};

export const MessageItem = memo(function MessageItem({
  chat,
  m,
  compact = false,
  replies,
  reactions,
  others,
  rootId,
  actions,
}: MessageItemProps) {
  const member = memberOfDevice(chat, m.senderDevice);
  const name = member?.display_name ?? "Unknown";
  const body = m.body;
  let content: React.ReactNode;
  if (m.status === "pending") content = <p className="text-text-2">Waiting for the key…</p>;
  else if (m.status === "error" || !body)
    content = <p className="text-text-2">Can't decrypt this message</p>;
  else if (body.type === "file") content = <FileBlock body={body} actions={actions} />;
  else if (body.type === "text" && member?.member_type === "agent")
    content = (
      <AgentMessage
        body={body}
        member={member}
        time={timeOf(m.ts)}
        reactions={reactions}
        onReact={(emoji, op) => actions.react(m.id, emoji, op)}
        onChip={(t) => actions.send(t, rootId)}
      />
    );
  else content = <LinkedText text={body.type === "text" ? body.text : ""} />;

  const isAgentCard = body?.type === "text" && member?.member_type === "agent" && m.status === "ok";
  const quote = body?.type === "text" ? body.text : body?.type === "file" ? body.name : "";
  const n = replies?.length ?? 0;
  const last = replies?.[n - 1];
  return (
    <div className="group relative flex gap-2.5 px-4 py-0.5 hover:bg-bg-1">
      {isAgentCard ? null : compact ? <span className="w-6 shrink-0" /> : <Avatar name={name} />}
      <div className="min-w-0 flex-1">
        {!isAgentCard && !compact && (
          <div className="text-[13px]">
            <strong className="font-semibold text-text-0">{name}</strong>{" "}
            <span className="text-text-2">{timeOf(m.ts)}</span>
          </div>
        )}
        {content}
        <ReactionBar
          reactions={reactions}
          onToggle={(emoji, op) => actions.react(m.id, emoji, op)}
        />
        {n > 0 && last && (
          <button
            type="button"
            onClick={() => actions.openThread(m.id)}
            className="mt-1 cursor-pointer text-[12px] text-text-1 hover:underline"
          >
            {`${n} ${n === 1 ? "reply" : "replies"} · last ${ago(last.ts)}`}
          </button>
        )}
        {!rootId && <WorkingBadge chatId={chat.id} messageId={m.id} />}
      </div>
      {m.status === "ok" && (
        <MessageActions
          chat={chat}
          messageId={m.id}
          text={quote}
          others={others}
          threadRoot={rootId}
          actions={actions}
        />
      )}
    </div>
  );
});
