import type { ChatMessage } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Conversation } from "../src/chat/Conversation";

const dev = (id: string) => ({ device_id: id, public_key: "k" });
const chat: Chat = {
  id: "chat-0001",
  title: "Project",
  kind: "group",
  created_by: "ana",
  members: [
    {
      member_type: "user",
      member_id: "ana",
      display_name: "Ana",
      role: "owner",
      devices: [dev("dev-ana")],
    },
    {
      member_type: "agent",
      member_id: "nora-id",
      display_name: "Nora",
      owner_display_name: "Ana",
      role: "member",
      devices: [dev("dev-nora")],
    },
  ],
};
const base = { chatId: chat.id, ts: 1_700_000_000_000, epoch: 1, status: "ok" as const };
const names: Record<string, string> = { "dev-ana": "Ana", "dev-nora": "Nora" };

const messages: ChatMessage[] = [
  {
    ...base,
    id: "m1",
    seq: 1,
    senderDevice: "dev-ana",
    body: { type: "text", text: "how is the cluster?" },
  },
  {
    ...base,
    id: "m2",
    seq: 2,
    senderDevice: "dev-nora",
    body: {
      type: "text",
      text: "All nodes are healthy.",
      meta: {
        tools: ["cluster_health"],
        ms: 1400,
        trace: [
          { kind: "thinking", text: "I should check the cluster first." },
          { kind: "tool", name: "cluster_health", args: '{"zone":"eu"}', result: "ok", ms: 120 },
        ],
      },
    },
  },
];

afterEach(cleanup);

it("shows an agent's pill, tools and time, and its reasoning on demand; humans get none", async () => {
  render(
    <Conversation
      chat={chat}
      messages={messages}
      nameOf={(d) => names[d] ?? "Someone"}
      onDownload={async () => {}}
    />,
  );
  expect(screen.getByText("agent · Ana's")).toBeTruthy();
  expect(screen.getByText("Used cluster_health · 1.4 s")).toBeTruthy();
  expect(screen.getAllByText(/agent ·/)).toHaveLength(1);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByText("I should check the cluster first.")).toBeNull();

  await userEvent.setup().click(screen.getByRole("button", { name: /Show reasoning/ }));
  expect(screen.getByText("I should check the cluster first.")).toBeTruthy();
  expect(screen.getByText("cluster_health", { selector: "strong" })).toBeTruthy();
  expect(screen.getByText('{"zone":"eu"}')).toBeTruthy();
});
