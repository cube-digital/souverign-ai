import { type ReactNode, useEffect } from "react";
import { useMatch, useNavigate } from "react-router";
import { ActivityRail } from "../rail/ActivityRail";
import { MembersRail } from "../rail/MembersRail";
import { NotesRail } from "../rail/NotesRail";
import { RelayRail } from "../rail/RelayRail";
import { useRail } from "../shell/rail";
import { ThreadPanel } from "./ThreadPanel";

/**
 * What the right rail shows: the thread of the URL, or the members, activity or relay panel the
 * header opened for the chat on screen. A thread asked for through the rail context (a row's
 * "N replies") moves to its URL, so threads can be linked and survive a reload.
 */
export function useRightRail(): { node: ReactNode | null; close: () => void } {
  const rail = useRail();
  const navigate = useNavigate();
  const m = useMatch("/c/:chatId/*");
  const chatId = m?.params.chatId;
  const thread = useMatch("/c/:chatId/t/:rootId");
  const rootId = thread?.params.rootId;
  const panel = rail.panel;

  useEffect(() => {
    if (!panel) return;
    if (panel.kind === "thread") {
      rail.close();
      navigate(`/c/${encodeURIComponent(panel.chatId)}/t/${encodeURIComponent(panel.rootId)}`);
    } else if (panel.chatId !== chatId) {
      rail.close();
    } else if (rootId) {
      // a panel replaces the open thread
      navigate(`/c/${encodeURIComponent(panel.chatId)}`);
    }
  }, [panel, chatId, rootId, rail, navigate]);

  if (chatId && rootId) {
    return {
      node: <ThreadPanel chatId={chatId} rootId={rootId} />,
      close: () => navigate(`/c/${encodeURIComponent(chatId)}`),
    };
  }
  let node: ReactNode | null = null;
  if (panel && panel.kind !== "thread" && panel.chatId === chatId) {
    node =
      panel.kind === "members" ? (
        <MembersRail chatId={panel.chatId} />
      ) : panel.kind === "activity" ? (
        <ActivityRail chatId={panel.chatId} />
      ) : panel.kind === "notes" ? (
        <NotesRail chatId={panel.chatId} />
      ) : (
        <RelayRail chatId={panel.chatId} />
      );
  }
  return { node, close: rail.close };
}
