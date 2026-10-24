import type { ChatEngine } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { agentDm } from "../api";

/**
 * Opens (or creates) the DM with an agent and makes sure it has a chat key, so the first message
 * can be sent at once. Every entry point to an agent DM goes through here.
 */
export async function openAgentDm(
  session: {
    engine: Pick<ChatEngine, "latestEpoch" | "createEpoch"> | null;
    refreshChats: () => Promise<unknown>;
  },
  agentId: string,
): Promise<Chat> {
  const dm = await agentDm(agentId);
  if (session.engine && (await session.engine.latestEpoch(dm.id)) === 0) {
    await session.engine.createEpoch(
      dm.id,
      dm.members.flatMap((m) => m.devices),
    );
  }
  await session.refreshChats();
  return dm;
}
