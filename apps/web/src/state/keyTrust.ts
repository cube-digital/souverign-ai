import type { Chat } from "@sa/protocol";

const trustedIn = (list: Chat[], chatId: string, senderDevice: string, epoch?: number) => {
  const chat = list.find((c) => c.id === chatId);
  if (!chat) return false;
  // Only an epoch the bridge handed out (claimed) can carry a key: with first-key-wins a member
  // could otherwise plant keys for future epochs.
  if (epoch !== undefined && epoch > (chat.key_epoch ?? 0)) return false;
  return chat.members.some(
    (m) => m.member_type === "user" && m.devices.some((d) => d.device_id === senderDevice),
  );
};

/**
 * A chat key is trusted when its sender is a device of an active human member and its epoch is not
 * past the chat's claimed `key_epoch`. A new member device or a fresh claim may postdate the
 * cached chats, so a failed check refreshes once and rechecks.
 */
export async function isTrustedKeySender(
  cached: Chat[],
  refresh: () => Promise<Chat[]>,
  chatId: string,
  senderDevice: string,
  epoch?: number,
): Promise<boolean> {
  return (
    trustedIn(cached, chatId, senderDevice, epoch) ||
    trustedIn(await refresh(), chatId, senderDevice, epoch)
  );
}
