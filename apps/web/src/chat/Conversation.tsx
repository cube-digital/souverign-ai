import type { ChatMessage } from "@sa/client";
import type { Chat, MessageBody, TraceStep } from "@sa/protocol";
import { useEffect, useRef, useState } from "react";
import { formatSize, timeOf } from "../lib/format";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Pill } from "../ui/Pill";

type FileBody = Extract<MessageBody, { type: "file" }>;
const GROUP_MS = 5 * 60 * 1000;

function Content({
  m,
  onDownload,
  isAgent = false,
}: {
  m: ChatMessage;
  onDownload: (body: FileBody) => Promise<void>;
  isAgent?: boolean;
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
  const text = (
    <p className="whitespace-pre-wrap break-words">{body.type === "text" ? body.text : ""}</p>
  );
  if (!isAgent || body.type !== "text" || !body.meta) return text;
  return (
    <>
      {text}
      <Reasoning meta={body.meta} />
    </>
  );
}

type Meta = NonNullable<Extract<MessageBody, { type: "text" }>["meta"]>;

const seconds = (ms: number) => (ms / 1000).toFixed(1);

function ToolStep({ step }: { step: Extract<TraceStep, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-[8px] border border-line bg-bg px-2.5 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <strong className="font-mono text-xs font-medium text-soft">{step.name}</strong>
        <span className="font-mono text-xs text-muted">{step.args}</span>
        <span className="ml-auto text-xs text-muted">{step.ms} ms</span>
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="mt-1 cursor-pointer text-xs text-muted hover:text-text"
      >
        {open ? "▾ Hide result" : "▸ Show result"}
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-soft">
          {step.result}
        </pre>
      )}
    </li>
  );
}

function Reasoning({ meta }: { meta: Meta }) {
  const [open, setOpen] = useState(false);
  const tools = meta.tools ?? [];
  const took = meta.ms === undefined ? null : `${seconds(meta.ms)} s`;
  const summary =
    tools.length > 0
      ? `Used ${tools.join(", ")}${took ? ` · ${took}` : ""}`
      : `Answered${took ? ` in ${took}` : ""}`;
  const trace = meta.trace ?? [];
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="cursor-pointer rounded-[8px] px-1 text-xs text-muted hover:text-text"
      >
        <span>{summary}</span> <span>{open ? "▴ Hide reasoning" : "▾ Show reasoning"}</span>
      </button>
      {open && (
        <ol className="mt-2 flex flex-col gap-2">
          {trace.map((step, i) =>
            step.kind === "thinking" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the trace is fixed once sent
              <li key={i} className="whitespace-pre-wrap break-words text-xs italic text-muted">
                {step.text}
              </li>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the trace is fixed once sent
              <ToolStep key={i} step={step} />
            ),
          )}
          {trace.length === 0 && <li className="text-xs text-muted">No steps were recorded.</li>}
        </ol>
      )}
    </div>
  );
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
    const agent = chat.members.find(
      (c) => c.member_type === "agent" && c.devices.some((d) => d.device_id === m.senderDevice),
    );
    if (agent) {
      const owner = agent.owner_display_name ?? "someone";
      return (
        <div key={m.id} className="flex gap-3">
          <Avatar name={name} agent />
          <div className="min-w-0 max-w-[620px] rounded-[12px] border border-agent-line bg-agent px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <strong className="font-semibold">{name}</strong>
              <Pill tone="teal">{`agent · ${owner}'s`}</Pill>
              <span className="text-muted">{timeOf(m.ts)}</span>
            </div>
            <div className="mt-1.5">
              <Content m={m} onDownload={onDownload} isAgent />
            </div>
          </div>
        </div>
      );
    }
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
