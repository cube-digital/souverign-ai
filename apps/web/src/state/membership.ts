import type { ChatEngine } from "@sa/client";
import type { Agent, Chat, DirectoryEntry } from "@sa/protocol";
import { addAgentToChat, addMember, claimEpoch, removeAgentFromChat, removeMember } from "../api";

type Ctx = {
  engine: Pick<ChatEngine, "latestEpoch" | "createEpoch" | "sendSystem">;
  chat: Chat;
  refresh: () => Promise<unknown>;
};

/** After the API changed the members: claim the next epoch, key every device, post the line, refresh. */
async function rekey(ctx: Ctx, updated: Chat, line: string): Promise<Chat> {
  const { engine, refresh } = ctx;
  const { epoch } = await claimEpoch(ctx.chat.id, (await engine.latestEpoch(ctx.chat.id)) + 1);
  await engine.createEpoch(
    updated.id,
    updated.members.flatMap((m) => m.devices),
    epoch,
  );
  await engine.sendSystem(updated.id, line);
  await refresh();
  return updated;
}

const JOINED = (name: string) => `${name} joined · new chat key · sees messages from now on`;

export async function addAgentWithKey(ctx: Ctx & { agent: Agent }): Promise<Chat> {
  const updated = await addAgentToChat(ctx.chat.id, ctx.agent.id);
  return rekey(ctx, updated, JOINED(ctx.agent.name));
}

export async function addPersonWithKey(ctx: Ctx & { person: DirectoryEntry }): Promise<Chat> {
  const updated = await addMember(ctx.chat.id, ctx.person.id);
  return rekey(ctx, updated, JOINED(ctx.person.display_name));
}

export async function removeWithKey(
  ctx: Ctx & {
    /** display name of the person who removes */
    actor: string;
    target: { kind: "user" | "agent"; id: string; name: string };
  },
): Promise<Chat> {
  const updated =
    ctx.target.kind === "agent"
      ? await removeAgentFromChat(ctx.chat.id, ctx.target.id)
      : await removeMember(ctx.chat.id, ctx.target.id);
  return rekey(ctx, updated, `${ctx.actor} removed ${ctx.target.name}.`);
}
