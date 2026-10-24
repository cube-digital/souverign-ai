import type { ChatEngine } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { agents } from "../api";
import { openAgentDm } from "../state/agentDm";

/** Opens the Scribe DM and makes sure it has a chat key. Returns the chat. */
export async function ensureScribeDm(
  engine: Pick<ChatEngine, "latestEpoch" | "createEpoch"> | null,
  refresh: () => Promise<unknown>,
): Promise<Chat> {
  const scribe = (await agents()).find((a) => a.roster_id === "scribe");
  if (!scribe) throw new Error("Scribe is not available yet");
  return openAgentDm({ engine, refreshChats: refresh }, scribe.id);
}
