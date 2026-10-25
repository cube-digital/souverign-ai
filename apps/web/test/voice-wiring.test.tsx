// Acceptance tests for T12 (web wiring). Assumed contracts:
//   - MessageList/MessageItem render a voice file with VoiceMessage (aria-label "voice message") and
//     put the text whose meta.transcript_of is the file id under that bubble, not in its own row.
//   - An agent text with meta.audio_id renders one VoiceMessage for that file; the file row is hidden.
//   - ChannelHeader has a "Start call" button: callApi.start -> engine.sendText(chat, "<Name> started a
//     call.", {call:{call_id, op:"started", media_key}}) -> callApi.anchor(callId, messageId) -> navigate.
//   - A text with meta.call_notes {state:"pending"} shows "Review notes"; {state:"not_published"} shows
//     "Publish notes again" which calls callApi.republish(notes_id) and then "Sent for your approval again."
import type { ChatMessage } from "@sa/client";
import type { CallInfo, Chat } from "@sa/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
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
      chats: [],
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

import { ChannelHeader } from "../src/channel/ChannelHeader";
import { MessageList } from "../src/channel/MessageList";

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

beforeEach(() => {
  seq = 0;
  h.messages = [];
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

it("shows a transcript under its voice message and an agent voice reply as one player with no file row", () => {
  h.messages = [
    msg("voice-0001", "dev-bob", voiceFile("voice-100.webm", "audio/webm", 4000)),
    msg("text-0001", "dev-scribe", {
      type: "text",
      text: "please move the standup to ten",
      meta: { transcript_of: "voice-0001" },
    }),
    msg("audio-0001", "dev-scribe", voiceFile("reply-0001.wav", "audio/wav", 2000)),
    msg("text-0002", "dev-scribe", {
      type: "text",
      text: "Standup moved to ten.",
      meta: { audio_id: "audio-0001" },
    }),
  ];
  const { container } = render(
    <MemoryRouter>
      <MessageList chat={chat} />
    </MemoryRouter>,
  );

  const players = screen.getAllByLabelText("voice message");
  expect(players).toHaveLength(2);
  expect(screen.getAllByText("please move the standup to ten")).toHaveLength(1);
  expect(players[0]?.parentElement?.textContent).toContain("please move the standup to ten");
  expect(container.querySelector('[data-message-id="text-0001"]')).toBeNull();
  expect(container.querySelector('[data-message-id="audio-0001"]')).toBeNull();
  expect(screen.queryByText("reply-0001.wav")).toBeNull();
  expect(screen.getAllByText("Standup moved to ten.")).toHaveLength(1);
});

it("Start call posts one call message with a fresh media key, anchors the call to it and opens the call page", async () => {
  const info: CallInfo = {
    id: "call-0001",
    chat_id: chat.id,
    room: "room-1",
    started_by: "ana",
    started_at: 1_000_000,
    ended_at: null,
    anchor_message_id: null,
    e2ee: true,
    participants: [{ user_id: "ana", name: "Ana", in_call: false, consent: "accepted" }],
    notetaker: null,
  };
  h.callApi.start.mockResolvedValue({ call: info });
  render(
    <MemoryRouter initialEntries={[`/c/${chat.id}`]}>
      <Routes>
        <Route path="/c/:chatId" element={<ChannelHeader chat={chat} />} />
        <Route path="/c/:chatId/call/:callId" element={<div>call page opened</div>} />
      </Routes>
    </MemoryRouter>,
  );

  await userEvent.click(screen.getByRole("button", { name: "Start call" }));

  expect(await screen.findByText("call page opened")).toBeTruthy();
  expect(h.callApi.start).toHaveBeenCalledWith(chat.id);
  expect(h.engine.sendText).toHaveBeenCalledTimes(1);
  const sent = h.engine.sendText.mock.calls[0] as unknown as [
    string,
    string,
    { call: { call_id: string; op: string; media_key: string } },
  ];
  expect(sent[0]).toBe(chat.id);
  expect(sent[1]).toBe("Ana started a call.");
  expect(sent[2].call.call_id).toBe("call-0001");
  expect(sent[2].call.op).toBe("started");
  expect(sent[2].call.media_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(h.callApi.anchor).toHaveBeenCalledTimes(1);
  expect(h.callApi.anchor).toHaveBeenCalledWith("call-0001", "msg-call-0001");
});

it("the inviter's DM offers Review notes for pending notes and Publish notes again for unpublished ones, which republishes", async () => {
  h.messages = [
    msg("dm-0001", "dev-scribe", {
      type: "text",
      text: "Notes for Weekly sync are waiting for you.",
      meta: { call_notes: { call_id: "call-0001", notes_id: "notes-0001", state: "pending" } },
    }),
    msg("dm-0002", "dev-scribe", {
      type: "text",
      text: "Notes for Design review were not published.",
      meta: {
        call_notes: { call_id: "call-0002", notes_id: "notes-0002", state: "not_published" },
      },
    }),
  ];
  render(
    <MemoryRouter>
      <MessageList chat={chat} />
    </MemoryRouter>,
  );

  expect(screen.getAllByRole("button", { name: "Review notes" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Publish notes again" })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Publish notes again" }));

  expect(h.callApi.republish).toHaveBeenCalledTimes(1);
  expect(h.callApi.republish).toHaveBeenCalledWith("notes-0002");
  expect(await screen.findByText("Sent for your approval again.")).toBeTruthy();
});
