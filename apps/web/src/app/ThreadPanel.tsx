import { useLocation } from "react-router";
import { ThreadView } from "../channel/ThreadView";
import { Composer } from "../composer/Composer";
import { useSession } from "../state/session";
import { composeFrom } from "./compose";

/** The thread of /c/:chatId/t/:rootId: the root, its replies and a composer that replies in it. */
export function ThreadPanel({ chatId, rootId }: { chatId: string; rootId: string }) {
  const chat = useSession().chats.find((c) => c.id === chatId);
  const location = useLocation();
  if (!chat) return null;
  const compose = composeFrom(location);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadView chatId={chatId} rootId={rootId} />
      <Composer
        chat={chat}
        replyTo={rootId}
        initial={compose}
        prefill={compose && { key: location.key, ...compose }}
        autoFocus
      />
    </div>
  );
}
