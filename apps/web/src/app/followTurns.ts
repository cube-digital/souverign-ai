import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router";
import { useActivity, useSession } from "../state/session";

/**
 * Agents answer in a thread under the message that tagged them. When a turn the user asked for
 * starts in this chat, the thread opens beside the channel, so the live status, the Stop button and
 * the answer are where they are looking. Each turn opens its thread once; closing it keeps it closed.
 */
export function useFollowOwnTurns(chatId: string | null): void {
  const { user } = useSession();
  const live = useActivity();
  const navigate = useNavigate();
  const { rootId } = useParams();
  const seen = useRef(new Set<string>());
  const open = useRef(rootId);
  open.current = rootId;

  useEffect(() => {
    if (!chatId) return;
    for (const a of Object.values(live[chatId] ?? {})) {
      const { turn_id, requester, reply_to } = a.body;
      if (requester !== user.id || !turn_id || !reply_to || seen.current.has(turn_id)) continue;
      seen.current.add(turn_id);
      if (open.current !== reply_to) {
        navigate(`/c/${encodeURIComponent(chatId)}/t/${encodeURIComponent(reply_to)}`);
      }
    }
  }, [live, chatId, user.id, navigate]);
}
