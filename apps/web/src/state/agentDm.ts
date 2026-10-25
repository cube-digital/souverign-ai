import type { ChatEngine } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { agentDm } from "../api";

type KeyEngine = Pick<ChatEngine, "latestEpoch" | "createEpoch">;

/** A DM between exactly one person and an agent. */
export const isAgentDm = (c: Chat): boolean =>
  c.kind === "dm" &&
  c.members.filter((m) => m.member_type === "user").length === 1 &&
  c.members.some((m) => m.member_type === "agent");

/**
 * Opens (or creates) the DM with an agent and makes sure it has a chat key, so the first message
 * can be sent at once. Every entry point to an agent DM goes through here. A DM another device
 * already keyed comes back with an unspent `key_epoch`, which this device mints instead of epoch 1.
 */
export async function openAgentDm(
  session: {
    engine: KeyEngine | null;
    refreshChats: () => Promise<unknown>;
  },
  agentId: string,
): Promise<Chat> {
  const dm = await agentDm(agentId);
  if (session.engine && (await session.engine.latestEpoch(dm.id)) === 0) {
    const devices = dm.members.flatMap((m) => m.devices);
    if (dm.key_epoch && dm.key_epoch > 1)
      await session.engine.createEpoch(dm.id, devices, dm.key_epoch);
    else await session.engine.createEpoch(dm.id, devices);
  }
  await session.refreshChats();
  return dm;
}
