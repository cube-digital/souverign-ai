// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { MessageBody } from "@sa/protocol";
import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router";
import { useRail } from "../shell/rail";
import { useSession } from "../state/session";

type FileBody = Extract<MessageBody, { type: "file" }>;

/** Stable callbacks for message rows, so rows stay memoised and never read the session themselves. */
export type RowActions = {
  react(messageId: string, emoji: string, op: "add" | "remove"): void;
  send(text: string, rootId?: string): void;
  download(body: FileBody): Promise<Uint8Array>;
  openThread(rootId: string): void;
  ask(rootId: string, agent: string, quote: string): void;
};

export function useRowActions(chatId: string): RowActions {
  const { engine } = useSession();
  const { open } = useRail();
  const navigate = useNavigate();
  const nav = useRef(navigate);
  useEffect(() => {
    nav.current = navigate;
  }, [navigate]);
  return useMemo(
    () => ({
      react: (id, emoji, op) => void engine?.sendReaction(chatId, id, emoji, op),
      send: (text, rootId) =>
        void engine?.sendText(chatId, text, undefined, rootId ? { replyTo: rootId } : undefined),
      download: async (body) => {
        if (!engine) throw new Error("offline");
        return engine.downloadFile(body);
      },
      openThread: (rootId) => open({ kind: "thread", chatId, rootId }),
      ask: (rootId, agent, quote) =>
        nav.current(`/c/${chatId}/t/${rootId}`, {
          state: { compose: { text: `@${agent} `, quote } },
        }),
    }),
    [engine, chatId, open],
  );
}
