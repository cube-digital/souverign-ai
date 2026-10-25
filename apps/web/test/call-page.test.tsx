import type { CallInfo, CallNotes, CallSegment } from "@sa/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatchBridgeEvent } from "../src/lib/bridge-events";

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

const seg = (over: Partial<CallSegment>): CallSegment => ({
  id: 1,
  speaker_user_id: "ana",
  speaker_name: "Ana",
  t_ms: 1000,
  text: "hello team",
  ...over,
});

it("with the call server down the page shows the media-off banner, consent and live capture, and a new segment appends", async () => {
  callApi.token.mockResolvedValue({ available: false, url: "", token: "", identity: "user:vlad" });
  callApi.segments.mockResolvedValue({ segments: [seg({})] });
  page();

  expect(
    await screen.findByText(
      /Call audio is off: the call server is not running on this Mac\. Consent and notes still work\./,
    ),
  ).toBeTruthy();
  expect(connectMedia).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
  expect(screen.getByText("What Scribe is capturing")).toBeTruthy();
  expect(await screen.findByText("hello team")).toBeTruthy();

  act(() =>
    dispatchBridgeEvent({
      type: "call.segment",
      call_id: CALL_ID,
      segment: seg({
        id: 2,
        speaker_user_id: "vlad",
        speaker_name: "Vlad",
        t_ms: 5000,
        text: "ship it",
      }),
    }),
  );
  expect(await screen.findByText(/Vlad · 00:05/)).toBeTruthy();
  expect(screen.getByText("ship it")).toBeTruthy();
});

it("anyone in the call, not only the inviter, can stop the notes", async () => {
  const user = userEvent.setup();
  page();

  await user.click(await screen.findByRole("button", { name: "Stop notes" }));
  expect(callApi.stop).toHaveBeenCalledWith(CALL_ID);
  expect(callApi.invite).not.toHaveBeenCalled();
});

it("the notes draft is rendered for the inviter only", async () => {
  const notes: CallNotes = {
    id: "notes-001",
    version: 1,
    final: false,
    body_md: "## Decisions\n\n- ship friday",
    action_items: [],
    status: "draft",
    approval_id: null,
  };
  callApi.notes.mockResolvedValue(notes);

  page();
  await screen.findByText(/invited by Ana/);
  expect(screen.queryByText(/Notes so far/)).toBeNull();
  expect(callApi.notes).not.toHaveBeenCalled();
  cleanup();

  me.id = "ana";
  me.display_name = "Ana";
  page();
  expect(await screen.findByText(/Notes so far · only you see this/)).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("heading", { name: "Decisions" })).toBeTruthy());
  expect(screen.getByText("ship friday")).toBeTruthy();
});
