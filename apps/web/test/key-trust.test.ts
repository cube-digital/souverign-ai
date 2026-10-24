import type { Chat } from "@sa/protocol";
import { expect, it, vi } from "vitest";
import { isTrustedKeySender } from "../src/state/keyTrust";

const chat = (keyEpoch: number): Chat => ({
  id: "chat-0001",
  title: "Team",
  kind: "group",
  created_by: "ana",
  key_epoch: keyEpoch,
  members: [
    {
      member_type: "user",
      member_id: "bob",
      display_name: "Bob",
      role: "member",
      devices: [{ device_id: "dev-bob", public_key: "k" }],
    },
  ],
});

it("rejects a member's key for an epoch past the claimed key_epoch, after one refresh", async () => {
  const refresh = vi.fn(async () => [chat(2)]);

  expect(await isTrustedKeySender([chat(2)], refresh, "chat-0001", "dev-bob", 3)).toBe(false);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(await isTrustedKeySender([chat(2)], refresh, "chat-0001", "dev-bob", 2)).toBe(true);
  // a claim newer than the cached chats is seen after the refresh
  const claimed = vi.fn(async () => [chat(3)]);
  expect(await isTrustedKeySender([chat(2)], claimed, "chat-0001", "dev-bob", 3)).toBe(true);
});
