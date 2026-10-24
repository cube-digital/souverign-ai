// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { Chat } from "@sa/protocol";
import { useState } from "react";
import { Card, ChipButton } from "../ds";
import { useSession } from "../state/session";

const PROMPTS = [
  "@Ops is anything about to go wrong?",
  "@QA is 7.4 ready to ship?",
  "@Scribe what did I miss?",
];

/** A pinned card in #general with one-click prompts; dismissed per user. */
export function TryThisCard({ chat }: { chat: Chat }) {
  const { user, engine } = useSession();
  const key = `sa.trythis.${user.id}`;
  const [gone, setGone] = useState(() => localStorage.getItem(key) === "1");
  if (chat.seed_key !== "general" || gone) return null;
  return (
    <Card ai className="mx-4 mt-3 flex flex-wrap items-center gap-2">
      <strong className="text-[13px] font-semibold text-text-0">Try this</strong>
      {PROMPTS.map((p) => (
        <ChipButton key={p} onClick={() => void engine?.sendText(chat.id, p)}>
          {p}
        </ChipButton>
      ))}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          localStorage.setItem(key, "1");
          setGone(true);
        }}
        className="ml-auto cursor-pointer text-text-2 hover:text-text-0"
      >
        Dismiss
      </button>
    </Card>
  );
}
