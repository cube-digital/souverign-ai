import type { ChatMessage } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildView } from "../src/state/threads";

const h = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  activity: {} as Record<string, Record<string, unknown>>,
  engine: {
    sendText: vi.fn(async () => {}),
    sendReaction: vi.fn(async () => {}),
    downloadFile: vi.fn(async () => new Uint8Array()),
  },
  open: vi.fn(),
  navigate: vi.fn(),
  stopTurn: vi.fn(async () => ({})),
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
    useActivity: () => h.activity,
  };
});
vi.mock("../src/shell/rail", () => ({
  useRail: () => ({ panel: null, open: h.open, close: () => {} }),
}));
vi.mock("../src/api", () => ({
  stopTurn: h.stopTurn,
  agents: vi.fn(async () => []),
}));
vi.mock("react-router", async (orig) => ({
  ...(await orig<typeof import("react-router")>()),
  useNavigate: () => h.navigate,
}));

import { LiveStatus } from "../src/channel/LiveStatus";
import { MessageList } from "../src/channel/MessageList";
import { TryThisCard } from "../src/channel/TryThisCard";

const dev = (id: string) => ({ device_id: id, public_key: "k" });
const chat: Chat = {
  id: "chat-general",
  title: "general",
  kind: "room",
  created_by: "mira",
  seed_key: "general",
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
      member_id: "ag-ops",
      display_name: "Ops",
      role: "member",
      agent_scope: "workspace",
      devices: [dev("dev-ops")],
    },
    {
      member_type: "agent",
      member_id: "ag-qa",
      display_name: "QA",
      role: "member",
      agent_scope: "workspace",
      devices: [dev("dev-qa")],
    },
  ],
};
const base = { chatId: chat.id, epoch: 1, status: "ok" as const };
let seq = 0;
const msg = (id: string, senderDevice: string, body: ChatMessage["body"]): ChatMessage => ({
  ...base,
  id,
  seq: ++seq,
  ts: Date.now() - 60_000 + seq,
  senderDevice,
  body,
});
const ui = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

beforeEach(() => {
  seq = 0;
  h.messages = [];
  h.activity = {};
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

it("shows a reply count on a thread root and opens that thread in the rail", async () => {
  h.messages = [
    msg("root-0001", "dev-bob", { type: "text", text: "deploy at five?" }),
    msg("rep-0001", "dev-ana", { type: "text", text: "yes", reply_to: "root-0001" }),
    msg("rep-0002", "dev-bob", { type: "text", text: "great", reply_to: "root-0001" }),
  ];
  ui(<MessageList chat={chat} />);
  await userEvent.click(screen.getByText(/2 replies/));
  expect(h.open).toHaveBeenCalledWith({ kind: "thread", chatId: chat.id, rootId: "root-0001" });
});

it("shows reaction counts and toggles only your own reaction", async () => {
  h.messages = [
    msg("m-0000001", "dev-bob", { type: "text", text: "shipped" }),
    msg("r-0000001", "dev-bob", { type: "reaction", target: "m-0000001", emoji: "🎉", op: "add" }),
    msg("r-0000002", "dev-ops", { type: "reaction", target: "m-0000001", emoji: "🎉", op: "add" }),
    msg("r-0000003", "dev-ana", { type: "reaction", target: "m-0000001", emoji: "🚀", op: "add" }),
  ];
  ui(<MessageList chat={chat} />);
  const party = screen.getByRole("button", { name: /🎉\s*2/ });
  await userEvent.click(party);
  expect(h.engine.sendReaction).toHaveBeenLastCalledWith(chat.id, "m-0000001", "🎉", "add");
  await userEvent.click(screen.getByRole("button", { name: /🚀\s*1/ }));
  expect(h.engine.sendReaction).toHaveBeenLastCalledWith(chat.id, "m-0000001", "🚀", "remove");
});

it("sends a Try this prompt as the user in #general", async () => {
  ui(<TryThisCard chat={chat} />);
  await userEvent.click(screen.getByRole("button", { name: "@QA is 7.4 ready to ship?" }));
  expect(h.engine.sendText).toHaveBeenCalledTimes(1);
  const call = h.engine.sendText.mock.calls[0] as unknown as unknown[];
  expect(call[0]).toBe(chat.id);
  expect(call[1]).toBe("@QA is 7.4 ready to ship?");
});

it("offers Stop only on the turn the current user requested", async () => {
  h.activity = {
    [chat.id]: {
      "dev-ops": {
        ts: Date.now(),
        body: { type: "activity", phase: "thinking", turn_id: "turn-mine01", requester: "ana" },
      },
      "dev-qa": {
        ts: Date.now(),
        body: { type: "activity", phase: "thinking", turn_id: "turn-bobs01", requester: "bob" },
      },
    },
  };
  ui(<LiveStatus chatId={chat.id} />);
  expect(screen.getByText(/Ops is thinking/)).toBeTruthy();
  expect(screen.getByText(/QA is thinking/)).toBeTruthy();
  const stops = screen.getAllByRole("button", { name: /Stop/ });
  expect(stops).toHaveLength(1);
  await userEvent.click(stops[0] as HTMLElement);
  expect(h.stopTurn).toHaveBeenCalledWith("turn-mine01");
});

it("Ask an agent opens the thread with the agent tagged and the message quoted", async () => {
  h.messages = [msg("m-0000001", "dev-bob", { type: "text", text: "node-3 disk looks odd" })];
  ui(<MessageList chat={chat} />);
  await userEvent.hover(screen.getByText("node-3 disk looks odd"));
  await userEvent.click(screen.getByText("Ask an agent…"));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ops" }));
  expect(h.navigate).toHaveBeenCalledWith(`/c/${chat.id}/t/m-0000001`, {
    state: { compose: { text: "@Ops ", quote: "node-3 disk looks odd" } },
  });
});
