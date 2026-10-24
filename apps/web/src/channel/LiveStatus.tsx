// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { ActivityBody, Chat } from "@sa/protocol";
import { stopTurn } from "../api";
import { Button } from "../ds";
import { useActivity, useSession } from "../state/session";
import { nameOfDevice } from "./shared";

function Caret() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-ai motion-safe:animate-pulse"
    />
  );
}

function line(name: string, b: ActivityBody): React.ReactNode {
  switch (b.phase) {
    case "queued":
      return `${name} · queued, ${b.ahead ?? 0} ahead`;
    case "thinking":
      return `${name} is thinking`;
    case "reading":
      return `${name} · reading ${b.count ?? 0} messages`;
    case "tool":
      return `${name} · calling \`${b.tool ?? "a tool"}\``;
    case "writing":
      return (
        <span className="whitespace-pre-wrap break-words">
          {b.draft}
          <Caret />
        </span>
      );
    default:
      return `${name} couldn't answer`;
  }
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
            role="status"
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
