import type { ChatMessage } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Conversation } from "../src/chat/Conversation";

const chat: Chat = {
  id: "chat-0001",
  title: "Project",
  kind: "group",
  created_by: "ana",
  members: [
    { member_type: "user", member_id: "ana", display_name: "Ana", role: "owner", devices: [] },
  ],
};

const base = { chatId: chat.id, ts: 1_700_000_000_000, senderDevice: "dev-ana", epoch: 1 };
const messages: ChatMessage[] = [
  {
    ...base,
    id: "m1",
    seq: 1,
    status: "ok",
    body: { type: "system", text: "Ana created this chat" },
  },
  { ...base, id: "m2", seq: 2, status: "ok", body: { type: "text", text: "hello AMBERFOX" } },
  { ...base, id: "m3", seq: 3, status: "error", body: null },
];

afterEach(cleanup);

it("renders text, a centred system line and the undecryptable placeholder", () => {
  render(
    <Conversation
      chat={chat}
      messages={messages}
      nameOf={() => "Ana"}
      onDownload={async () => {}}
    />,
  );
  expect(screen.getByText("hello AMBERFOX")).toBeTruthy();
  expect(screen.getByText("Ana created this chat").className).toContain("self-center");
  expect(screen.getByText("Can't decrypt this message")).toBeTruthy();
});
