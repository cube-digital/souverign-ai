import type { ChatEngine } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { agentDm, claimEpoch } from "../api";

type KeyEngine = Pick<ChatEngine, "latestEpoch" | "createEpoch">;

/** A DM between exactly one person and an agent. */
export const isAgentDm = (c: Chat): boolean =>
  c.kind === "dm" &&
  c.members.filter((m) => m.member_type === "user").length === 1 &&
  c.members.some((m) => m.member_type === "agent");

/**
 * Opens (or creates) the DM with an agent and makes sure it has a chat key, so the first message
 * can be sent at once. Every entry point to an agent DM goes through here. A DM another device
 * already keyed comes back with a `key_epoch` past 1: this device then claims a fresh epoch instead
 * of minting a second epoch 1, which the agent (first key wins) could not read.
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
    if (dm.key_epoch && dm.key_epoch > 1) {
      // several devices of mine can get here at once (one request event reaches all of them):
      // each claims its own epoch, so no two keys share one
      const { epoch } = await claimEpoch(dm.id, dm.key_epoch);
      await session.engine.createEpoch(dm.id, devices, epoch);
    } else await session.engine.createEpoch(dm.id, devices);
  }
  await session.refreshChats();
  return dm;
}
