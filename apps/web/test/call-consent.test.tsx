import type { CallInfo } from "@sa/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const CALL_ID = "call-0001";
const CHAT_ID = "chat-0001";

const callApi = vi.hoisted(() => ({
  get: vi.fn(),
  token: vi.fn(),
  leave: vi.fn(),
  end: vi.fn(),
  invite: vi.fn(),
  consent: vi.fn(),
  stop: vi.fn(),
  segments: vi.fn(),
  notes: vi.fn(),
  republish: vi.fn(),
}));
vi.mock("../src/call/api", () => ({ callApi }));

const connectMedia = vi.hoisted(() => vi.fn());
vi.mock("../src/call/media", () => ({ connectMedia }));

const me = vi.hoisted(() => ({ id: "vlad", display_name: "Vlad" }));
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    user: me,
    chats: [
      { id: "chat-0001", title: "Release room", kind: "group", created_by: "ana", members: [] },
    ],
    messages: {},
    engine: { latestEpoch: async () => 1, createEpoch: async () => {}, sendSystem: async () => {} },
    refreshChats: async () => [],
    unread: {},
  }),
  useActivity: () => ({}),
}));
vi.mock("../src/state/membership", () => ({ addAgentWithKey: vi.fn() }));

const info = (over: Partial<CallInfo> = {}): CallInfo => ({
  id: CALL_ID,
  chat_id: CHAT_ID,
  room: "room-1",
  started_by: "ana",
  started_at: Date.now() - 65_000,
  ended_at: null,
  anchor_message_id: null,
  e2ee: false,
  participants: [
    { user_id: "ana", name: "Ana", in_call: true, consent: "accepted" },
    { user_id: "vlad", name: "Vlad", in_call: true, consent: "pending" },
    { user_id: "rares", name: "Rareș", in_call: true, consent: "declined" },
  ],
  notetaker: {
    id: "ntk-00001",
    agent_id: "ag-scribe",
    agent_name: "Scribe",
    invited_by: "ana",
    invited_by_name: "Ana",
    invited_at: Date.now() - 60_000,
    status: "active",
    worker: "fake",
    stopped_by_name: null,
  },
  ...over,
});

const session = {
  leave: vi.fn(),
  mute: vi.fn(),
  onActiveSpeakers: vi.fn(() => () => {}),
  onState: vi.fn(() => () => {}),
};

function page() {
  return render(
    <MemoryRouter initialEntries={[`/c/${CHAT_ID}/call/${CALL_ID}`]}>
      <Routes>
        <Route path="/c/:chatId/call/:callId" element={<CallPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  me.id = "vlad";
  me.display_name = "Vlad";
  callApi.get.mockResolvedValue(info());
  callApi.token.mockResolvedValue({
    available: true,
    url: "ws://x",
    token: "t",
    identity: "user:vlad",
  });
  callApi.segments.mockResolvedValue({ segments: [] });
  callApi.notes.mockResolvedValue(null);
  callApi.consent.mockResolvedValue(info());
  callApi.stop.mockResolvedValue(info());
  connectMedia.mockResolvedValue(session);
});
afterEach(cleanup);

import { CallPage } from "../src/call/CallPage";

it("a pending participant sees who invited Scribe and can accept; the inviter never sees the banner", async () => {
  const user = userEvent.setup();
  const first = page();

  expect(
    await screen.findByText(
      /Ana invited Scribe to take notes\. Scribe transcribes only people who accept, on this Mac\. Notes go to Ana first and reach the chat only if Ana approves\./,
    ),
  ).toBeTruthy();
  callApi.consent.mockResolvedValue(
    info({
      participants: [
        { user_id: "ana", name: "Ana", in_call: true, consent: "accepted" },
        { user_id: "vlad", name: "Vlad", in_call: true, consent: "accepted" },
      ],
    }),
  );
  await user.click(screen.getByRole("button", { name: "Accept" }));
  expect(callApi.consent).toHaveBeenCalledWith(CALL_ID, "accepted");
  expect(await screen.findByText("You are captured")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  first.unmount();

  me.id = "ana";
  me.display_name = "Ana";
  callApi.get.mockResolvedValue(
    info({
      participants: info().participants.map((p) =>
        p.user_id === "ana" ? { ...p, consent: "accepted" } : p,
      ),
    }),
  );
  page();
  await screen.findByText(/invited by Ana/);
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
});
