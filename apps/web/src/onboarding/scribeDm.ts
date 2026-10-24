import type { ChatEngine } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { agentDm, agents } from "../api";

/** Opens the Scribe DM and makes sure it has a chat key. Returns the chat. */
export async function ensureScribeDm(
  engine: Pick<ChatEngine, "latestEpoch" | "createEpoch"> | null,
  refresh: () => Promise<unknown>,
): Promise<Chat> {
  const scribe = (await agents()).find((a) => a.roster_id === "scribe");
  if (!scribe) throw new Error("Scribe is not available yet");
  const dm = await agentDm(scribe.id);
  if (engine && (await engine.latestEpoch(dm.id)) === 0) {
    await engine.createEpoch(
      dm.id,
      dm.members.flatMap((m) => m.devices),
    );
  }
  await refresh();
  return dm;
}
