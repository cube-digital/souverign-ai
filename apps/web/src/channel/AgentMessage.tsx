// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { ChatMember, MessageBody } from "@sa/protocol";
import { memo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentAvatar, Chip, ChipButton, StatusDot } from "../ds";
import { cn } from "../lib/cn";
import type { Reaction } from "../state/threads";
import { ReceiptsFooter } from "./ReceiptsFooter";

type TextBody = Extract<MessageBody, { type: "text" }>;

const MAX_LINES = 8;
const PREVIEW_LINES = 3;

/** The first 3 non-empty lines of an answer longer than 8, or null when it stays whole. */
export function collapse(text: string): string | null {
  const lines = text.split("\n");
  if (lines.filter((l) => l.trim()).length <= MAX_LINES) return null;
  const out: string[] = [];
  let seen = 0;
  for (const l of lines) {
    out.push(l);
    if (l.trim() && ++seen === PREVIEW_LINES) break;
  }
  return out.join("\n");
}

export function AgentStatusChip({ status }: { status: ChatMember["status"] }) {
  return status ? <StatusDot status={status === "error" ? "error" : status} /> : null;
}

function Helpful({
  reactions,
  onReact,
}: {
  reactions: Reaction[] | undefined;
  onReact: (emoji: string, op: "add" | "remove") => void;
}) {
  const btn = (emoji: string, label: string) => {
    const mine = reactions?.some((r) => r.emoji === emoji && r.mine) ?? false;
    return (
      <button
        type="button"
        aria-label={label}
        aria-pressed={mine}
        onClick={() => onReact(emoji, mine ? "remove" : "add")}
        className={cn(
          "cursor-pointer rounded-sm px-1 text-[12px] hover:bg-bg-2",
          mine ? "opacity-100" : "opacity-60 hover:opacity-100",
        )}
      >
        {emoji}
      </button>
    );
  };
  return (
    <span className="ml-auto inline-flex gap-0.5">
      {btn("👍", "Helpful")}
      {btn("👎", "Not helpful")}
    </span>
  );
}

/** Markdown of an agent answer; memoised so unrelated re-renders do not re-parse it. */
const AnswerMarkdown = memo(function AnswerMarkdown({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </Markdown>
  );
});

/** An agent's text answer: AI chip, markdown body, reasoning, receipts and feedback. */
export function AgentMessage({
  body,
  member,
  time,
  reactions,
  onReact,
  onChip,
}: {
  body: TextBody;
  member: ChatMember;
  time: string;
  reactions: Reaction[] | undefined;
  onReact: (emoji: string, op: "add" | "remove") => void;
  /** a chip was clicked; the caller sends it in the same place (thread or chat) */
  onChip: (text: string) => void;
}) {
  const [more, setMore] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const meta = body.meta;
  const short = collapse(body.text);
  const shown = short && !more ? short : body.text;
  const thinking = (meta?.trace ?? []).filter((s) => s.kind === "thinking");
  const tools = meta?.tools?.length ?? 0;
  const owner =
    member.agent_scope === "workspace"
      ? "Workspace agent"
      : `${member.owner_display_name ?? "Someone"}'s agent`;
  return (
    <div className="min-w-0 max-w-[640px] rounded-lg border border-ai-glow bg-ai-bg px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
        <AgentAvatar name={member.display_name} id={member.member_id} size={18} />
        <strong className="font-semibold text-text-0">{member.display_name}</strong>
        <Chip tone="ai">AI</Chip>
        <Chip>{owner}</Chip>
        <AgentStatusChip status={member.status} />
        {tools > 0 && !meta?.seeded && <Chip>{`${tools} tool${tools === 1 ? "" : "s"}`}</Chip>}
        <span className="text-text-2">{time}</span>
      </div>
      <div className="mt-1 break-words text-text-0 [&_a]:underline [&_code]:font-mono [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:overflow-auto [&_ul]:list-disc [&_ul]:pl-5">
        <AnswerMarkdown text={shown} />
      </div>
      {short && (
        <button
          type="button"
          aria-expanded={more}
          onClick={() => setMore((m) => !m)}
          className="cursor-pointer text-[12px] text-text-2 hover:text-text-0"
        >
          {more ? "Show less" : "Show more"}
        </button>
      )}
      {thinking.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            aria-expanded={reasoning}
            onClick={() => setReasoning((r) => !r)}
            className="cursor-pointer text-[12px] text-text-2 hover:text-text-0"
          >
            {reasoning ? "Hide reasoning" : "Show reasoning"}
          </button>
          {reasoning &&
            thinking.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the trace is fixed once sent
              <p key={i} className="mt-1 whitespace-pre-wrap text-[12px] italic text-text-2">
                {s.text}
              </p>
            ))}
        </div>
      )}
      {meta?.chips && meta.chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {meta.chips.map((c) => (
            <ChipButton key={c} onClick={() => onChip(`@${member.display_name} ${c}`)}>
              {c}
            </ChipButton>
          ))}
        </div>
      )}
      {meta?.seeded ? (
        <p className="mt-2 text-[12px] text-text-2">example history</p>
      ) : (
        <div className="flex items-end">
          {meta && <ReceiptsFooter meta={meta} />}
          <Helpful reactions={reactions} onReact={onReact} />
        </div>
      )}
    </div>
  );
}
