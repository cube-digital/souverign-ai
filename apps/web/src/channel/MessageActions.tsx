// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { Agent, Chat } from "@sa/protocol";
import { useNavigate } from "react-router";
import { IconButton, Icons, Menu } from "../ds";
import { useRail } from "../shell/rail";
import { useSession } from "../state/session";

const QUICK = ["👍", "✅", "👀", "❤️"];

/** The hover toolbar of a message. */
export function MessageActions({
  chat,
  messageId,
  text,
  others,
  inThread,
}: {
  chat: Chat;
  messageId: string;
  /** the message text, quoted when asking an agent */
  text: string;
  /** workspace agents that are not in the chat */
  others: Agent[];
  inThread: boolean;
}) {
  const { engine } = useSession();
  const rail = useRail();
  const navigate = useNavigate();
  const ask = (name: string) =>
    navigate(`/c/${chat.id}/t/${messageId}`, {
      state: { compose: { text: `@${name} `, quote: text } },
    });
  const items = [
    ...chat.members.filter((m) => m.member_type === "agent").map((m) => m.display_name),
    ...others.map((a) => a.name),
  ].map((name) => ({ label: name, onSelect: () => ask(name) }));
  return (
    <div className="absolute -top-3 right-2 z-10 flex items-center gap-0.5 rounded-md border border-border-soft bg-bg-1 px-1 py-0.5 opacity-0 shadow-[var(--shadow-1)] focus-within:opacity-100 group-hover:opacity-100">
      {QUICK.map((e) => (
        <IconButton
          key={e}
          label={`React with ${e}`}
          onClick={() => void engine?.sendReaction(chat.id, messageId, e, "add")}
        >
          {e}
        </IconButton>
      ))}
      {!inThread && (
        <IconButton
          label="Reply in thread"
          onClick={() => rail.open({ kind: "thread", chatId: chat.id, rootId: messageId })}
        >
          <Icons.Reply />
        </IconButton>
      )}
      {items.length > 0 && (
        <Menu label="Ask an agent…" trigger={<span>Ask an agent…</span>} items={items} />
      )}
      <IconButton label="Copy text" onClick={() => void navigator.clipboard?.writeText(text)}>
        <Icons.Check />
      </IconButton>
    </div>
  );
}
