import type { ChatMessage } from "@sa/client";
import type { Chat, MessageBody } from "@sa/protocol";
import { useEffect, useRef, useState } from "react";
import { formatSize, timeOf } from "../lib/format";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";

type FileBody = Extract<MessageBody, { type: "file" }>;
const GROUP_MS = 5 * 60 * 1000;

function Content({
  m,
  onDownload,
}: {
  m: ChatMessage;
  onDownload: (body: FileBody) => Promise<void>;
}) {
  const [failed, setFailed] = useState(false);
  if (m.status === "pending") return <p className="text-muted">Waiting for the key…</p>;
  if (m.status === "error" || !m.body) {
    return <p className="text-muted">Can't decrypt this message</p>;
  }
  const body = m.body;
  if (body.type === "file") {
    return (
      <div className="mt-1 inline-flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-panel-2 px-3 py-2">
        <span className="text-soft">{body.name}</span>
        <span className="text-xs text-muted">{formatSize(body.size)}</span>
        <Button
          className="!min-h-8 !px-3 text-xs"
          onClick={() => {
            setFailed(false);
            onDownload(body).catch(() => setFailed(true));
          }}
        >
          Download
        </Button>
        {failed && <span className="text-xs text-danger">Download failed</span>}
      </div>
    );
  }
  return <p className="whitespace-pre-wrap break-words">{body.type === "text" ? body.text : ""}</p>;
}

export function Conversation({
  chat,
  messages,
  nameOf,
  onDownload,
  onOpenMembers,
}: {
  chat: Chat;
  messages: ChatMessage[];
  nameOf: (deviceId: string) => string;
  onDownload: (body: FileBody) => Promise<void>;
  onOpenMembers?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the list grows
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  let prev: ChatMessage | null = null;
  const rows = messages.map((m) => {
    if (m.status === "ok" && m.body?.type === "system") {
      prev = null;
      return (
        <div
          key={m.id}
          className="self-center rounded-[10px] border border-line bg-panel px-3.5 py-2 text-center text-[13px] text-muted"
        >
          {m.body.text}
        </div>
      );
    }
    const grouped =
      prev !== null && prev.senderDevice === m.senderDevice && m.ts - prev.ts < GROUP_MS;
    prev = m;
    const name = nameOf(m.senderDevice);
    return (
      <div key={m.id} className={`flex gap-3 ${grouped ? "-mt-3.5" : ""}`}>
        {grouped ? <span className="w-9 shrink-0" /> : <Avatar name={name} />}
        <div className="min-w-0">
          {!grouped && (
            <div className="text-[13px]">
              <strong className="font-semibold">{name}</strong>{" "}
              <span className="text-muted">{timeOf(m.ts)}</span>
            </div>
          )}
          <Content m={m} onDownload={onDownload} />
        </div>
      </div>
    );
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3.5">
        <div className="min-w-0 flex-1 basis-60">
          <h1 className="text-[17px] font-semibold">
            <span aria-hidden="true"># </span>
            <span>{chat.title}</span>
          </h1>
          <div className="text-xs text-muted">
            {chat.members.map((m) => m.display_name).join(", ")}
          </div>
        </div>
        {onOpenMembers && <Button onClick={onOpenMembers}>Members</Button>}
      </div>
      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-6 py-5"
      >
        {rows}
      </div>
    </div>
  );
}
