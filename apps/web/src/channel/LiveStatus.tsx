// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { ActivityBody, Chat } from "@sa/protocol";
import { useMemo } from "react";
import { stopTurn } from "../api";
import { Button } from "../ds";
import { useActivity, useSession } from "../state/session";
import { describePhase, nameOfDevice } from "./shared";

function Caret() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-ai motion-safe:animate-pulse"
    />
  );
}

function line(name: string, b: ActivityBody): React.ReactNode {
  if (b.phase === "writing") {
    return (
      <span className="whitespace-pre-wrap break-words">
        {b.draft}
        <Caret />
      </span>
    );
  }
  return describePhase(b, name, "line") ?? `${name} couldn't answer`;
}

/** Live agent activity of a chat (top level) or of one thread. */
export function LiveStatus({
  chatId,
  rootId,
  chat,
}: {
  chatId: string;
  rootId?: string | undefined;
  chat?: Chat | undefined;
}) {
  const { user, chats } = useSession();
  const all = useActivity()[chatId] ?? {};
  const known = chat ?? chats.find((c) => c.id === chatId);
  const rows = Object.entries(all).filter(([, a]) => a.body.reply_to === rootId);
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 px-4 py-2">
      {rows.map(([device, a]) => {
        const name = nameOfDevice(known, device);
        const canStop = a.body.requester === user.id && a.body.turn_id;
        return (
          <div
            key={device}
            data-testid="agent-activity"
            className="flex items-center gap-2 rounded-md border border-ai-glow bg-ai-bg px-2.5 py-1.5 text-[13px] text-text-1"
          >
            <span className="min-w-0 flex-1">{line(name, a.body)}</span>
            {canStop && (
              <Button
                size="sm"
                aria-label={`Stop ${name}`}
                onClick={() => void stopTurn(a.body.turn_id as string).catch(() => {})}
              >
                Stop
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Tiny "working…" hint on a thread root; the only part of a row that follows live activity. */
export function WorkingBadge({ chatId, messageId }: { chatId: string; messageId: string }) {
  const working = Object.values(useActivity()[chatId] ?? {}).some(
    (a) => a.body.reply_to === messageId,
  );
  return working ? <p className="mt-1 text-[12px] text-ai">working…</p> : null;
}

/**
 * One always-mounted polite live region per channel. It speaks phase and queue changes only;
 * drafts and tool names never reach it, so streaming text is not read out.
 */
export function LiveAnnouncer({ chat }: { chat: Chat }) {
  const all = useActivity()[chat.id];
  const text = useMemo(
    () =>
      Object.entries(all ?? {})
        .map(([device, a]) => describePhase(a.body, nameOfDevice(chat, device), "speech"))
        .filter(Boolean)
        .join(". "),
    [all, chat],
  );
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  );
}
