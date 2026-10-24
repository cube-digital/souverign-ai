import type { ChatMessage } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { cleanup, render, screen } from "@testing-library/react";
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
const final: ChatMessage = {
  id: "m1",
  chatId: chat.id,
  seq: 1,
  ts: 1_700_000_000_000,
  senderDevice: "dev-nora",
  epoch: 1,
  status: "ok",
  body: { type: "text", text: "The final answer." },
};
const activity = {
  "dev-nora": {
    body: { type: "activity" as const, phase: "writing" as const, draft: "Draft so" },
    ts: 1,
  },
};
const props = { chat, nameOf: () => "Nora", onDownload: async () => {} };

afterEach(cleanup);

it("shows a writing draft in an agent bubble until the final message arrives", () => {
  const { rerender } = render(<Conversation {...props} messages={[]} activity={activity} />);
  const bubble = screen.getByTestId("agent-activity");
  expect(bubble.textContent).toContain("Draft so");
  expect(bubble.textContent).toContain("agent · Ana's");

  rerender(<Conversation {...props} messages={[final]} activity={{}} />);
  expect(screen.queryByTestId("agent-activity")).toBeNull();
  expect(screen.getByText("The final answer.")).toBeTruthy();
});
