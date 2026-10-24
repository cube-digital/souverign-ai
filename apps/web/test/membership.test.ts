import type { Chat } from "@sa/protocol";
import { beforeEach, expect, it, vi } from "vitest";

const log: string[] = [];
vi.mock("../src/api", () => ({
  addAgentToChat: vi.fn(async (chatId: string, agentId: string) => {
    log.push(`add:${chatId}:${agentId}`);
    return updated;
  }),
  claimEpoch: vi.fn(async (chatId: string, min: number) => {
    log.push(`claim:${chatId}:${min}`);
    return { epoch: 7 };
  }),
}));

import * as api from "../src/api";
import { addAgentWithKey } from "../src/state/membership";

const updated: Chat = {
  id: "chat-0001",
  title: "T",
  kind: "group",
  created_by: "ana",
  members: [
    {
      member_type: "user",
      member_id: "ana",
      display_name: "Ana",
      role: "owner",
      devices: [{ device_id: "dev-ana", public_key: "k1" }],
    },
    {
      member_type: "agent",
      member_id: "ag1",
      display_name: "Nora",
      role: "member",
      devices: [{ device_id: "dev-nora", public_key: "k2" }],
    },
  ],
};
const agent = {
  id: "ag1",
  name: "Nora",
  template: "general",
  soul: "",
  owner_user_id: null,
  device_id: "dev-nora",
  status: "running",
  scope: "workspace",
  roster_id: null,
} as const;

const engine = {
  latestEpoch: vi.fn(async () => 4),
  createEpoch: vi.fn(async (...a: unknown[]) => {
    log.push(`epoch:${a[0]}:${a[2]}`);
    return 7;
  }),
  sendSystem: vi.fn(async (_c: string, text: string) => {
    log.push(`system:${text}`);
  }),
};
beforeEach(() => {
  log.length = 0;
});

it("claims epoch latest+1, creates that epoch for every device, posts the join line, then refreshes", async () => {
  const refresh = vi.fn(async () => {
    log.push("refresh");
    return [];
  });
  const result = await addAgentWithKey({
    // biome-ignore lint/suspicious/noExplicitAny: minimal engine fake
    engine: engine as any,
    chat: { ...updated, members: [updated.members[0]] } as Chat,
    agent,
    refresh,
  });
  expect(result).toEqual(updated);
  expect(api.claimEpoch).toHaveBeenCalledWith("chat-0001", 5);
  expect(engine.createEpoch).toHaveBeenCalledWith(
    "chat-0001",
    [
      { device_id: "dev-ana", public_key: "k1" },
      { device_id: "dev-nora", public_key: "k2" },
    ],
    7,
  );
  expect(log).toEqual([
    "add:chat-0001:ag1",
    "claim:chat-0001:5",
    "epoch:chat-0001:7",
    "system:Nora joined · new chat key · sees messages from now on",
    "refresh",
  ]);
});
