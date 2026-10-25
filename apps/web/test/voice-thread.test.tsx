// Voice rows fold the same way inside a thread: transcript under its bubble, one player, latency pill.
import type { ChatMessage } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  chat: undefined as unknown as Chat,
  engine: {
    sendText: vi.fn(async (..._a: unknown[]) => "msg-call-0001"),
    sendReaction: vi.fn(async () => {}),
    downloadFile: vi.fn(async () => new Uint8Array()),
  },
  callApi: {
    get: vi.fn(),
    start: vi.fn(),
    anchor: vi.fn(async () => ({ ok: true })),
    republish: vi.fn(async () => ({ approval_id: "ap-0001" })),
  },
}));

vi.mock("../src/state/session", async () => {
  const { buildView } = await import("../src/state/threads");
  return {
    useSession: () => ({
      user: { id: "ana", display_name: "Ana" },
      deviceId: "dev-ana",
      engine: h.engine,
      chats: [h.chat],
      messages: {},
      unread: {},
      view: () => buildView(h.messages, "dev-ana"),
      refreshChats: async () => [],
    }),
    useActivity: () => ({}),
  };
});
vi.mock("../src/shell/rail", () => ({
  useRail: () => ({ panel: null, open: () => {}, close: () => {} }),
}));
vi.mock("../src/api", () => ({
  stopTurn: vi.fn(),
  agents: vi.fn(async () => []),
}));
vi.mock("../src/call/api", () => ({ callApi: h.callApi }));

import { ThreadView } from "../src/channel/ThreadView";

const dev = (id: string) => ({ device_id: id, public_key: "k" });
const chat: Chat = {
  id: "chat-0001",
  title: "general",
  kind: "room",
  created_by: "ana",
  members: [
    {
      member_type: "user",
      member_id: "ana",
      display_name: "Ana",
      role: "member",
      devices: [dev("dev-ana")],
    },
    {
      member_type: "user",
      member_id: "bob",
      display_name: "Bob",
      role: "member",
      devices: [dev("dev-bob")],
    },
    {
      member_type: "agent",
      member_id: "ag-scribe",
      display_name: "Scribe",
      role: "member",
      agent_scope: "workspace",
      devices: [dev("dev-scribe")],
    },
  ],
};
let seq = 0;
const msg = (id: string, senderDevice: string, body: ChatMessage["body"]): ChatMessage => ({
  chatId: chat.id,
  epoch: 1,
  status: "ok",
  id,
  seq: ++seq,
  ts: Date.now() - 60_000 + seq,
  senderDevice,
  body,
});
const voiceFile = (name: string, mime: string, ms: number): ChatMessage["body"] => ({
  type: "file",
  blob_id: `blob-${name}`,
  name,
  mime,
  size: 2048,
  key: "a2V5",
  nonce: "bm9uY2U",
  voice: { duration_ms: ms },
});

h.chat = chat;

beforeEach(() => {
  seq = 0;
  vi.clearAllMocks();
});
afterEach(cleanup);

it("a thread folds the transcript under the voice root and shows one reply player with the latency pill for the speaker", () => {
  h.messages = [
    msg("voice-0001", "dev-ana", voiceFile("voice-100.webm", "audio/webm", 4000)),
    msg("text-0001", "dev-scribe", {
      type: "text",
      text: "move standup to ten",
      meta: { transcript_of: "voice-0001" },
      reply_to: "voice-0001",
    }),
    msg("audio-0001", "dev-scribe", {
      ...voiceFile("reply-0001.wav", "audio/wav", 2000),
      reply_to: "voice-0001",
    } as ChatMessage["body"]),
    msg("text-0002", "dev-scribe", {
      type: "text",
      text: "Standup moved.",
      reply_to: "voice-0001",
      meta: {
        audio_id: "audio-0001",
        latency: { stt_ms: 300, first_audio_ms: 1800, total_ms: 2500 },
      },
    }),
  ];
  const { container } = render(
    <MemoryRouter>
      <ThreadView chatId={chat.id} rootId="voice-0001" />
    </MemoryRouter>,
  );
  expect(screen.getAllByLabelText("voice message")).toHaveLength(2);
  expect(screen.getAllByText("move standup to ten")).toHaveLength(1);
  expect(container.querySelector('[data-message-id="text-0001"]')).toBeNull();
  expect(container.querySelector('[data-message-id="audio-0001"]')).toBeNull();
  expect(screen.getByText("voice to voice 1.8 s")).toBeTruthy();
});
