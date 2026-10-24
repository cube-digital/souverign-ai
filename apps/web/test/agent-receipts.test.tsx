import type { ChatMessage } from "@sa/client";
import type { Chat } from "@sa/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  chats: [] as unknown[],
  activity: {} as Record<string, Record<string, unknown>>,
  engine: {
    sendText: vi.fn(async () => {}),
    sendReaction: vi.fn(async () => {}),
    downloadFile: vi.fn(async () => new Uint8Array()),
  },
}));

vi.mock("../src/state/session", async () => {
  const { buildView } = await import("../src/state/threads");
  return {
    useSession: () => ({
      user: { id: "ana", display_name: "Ana" },
      deviceId: "dev-ana",
      engine: h.engine,
      chats: h.chats,
      messages: {},
      unread: {},
      view: () => buildView(h.messages, "dev-ana"),
      refreshChats: async () => [],
    }),
    useActivity: () => h.activity,
  };
});
vi.mock("../src/shell/rail", () => ({
  useRail: () => ({ panel: null, open: vi.fn(), close: () => {} }),
}));
vi.mock("../src/api", () => ({ stopTurn: vi.fn(), agents: vi.fn(async () => []) }));

import { LiveStatus } from "../src/channel/LiveStatus";
import { MessageList } from "../src/channel/MessageList";
import { ThreadView } from "../src/channel/ThreadView";

const dev = (id: string) => ({ device_id: id, public_key: "k" });
const chat: Chat = {
  id: "chat-release",
  title: "release-7.4",
  kind: "room",
  created_by: "mira",
  seed_key: "release-7.4",
  members: [
    {
      member_type: "user",
      member_id: "ana",
      display_name: "Ana",
      role: "member",
      devices: [dev("dev-ana")],
    },
    {
      member_type: "agent",
      member_id: "ag-ops",
      display_name: "Ops",
      role: "member",
      agent_scope: "workspace",
      devices: [dev("dev-ops")],
    },
  ],
};
let seq = 0;
const msg = (id: string, senderDevice: string, body: ChatMessage["body"]): ChatMessage => ({
  id,
  chatId: chat.id,
  epoch: 1,
  status: "ok",
  seq: ++seq,
  ts: Date.now() - 60_000 + seq,
  senderDevice,
  body,
});
const ui = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

beforeEach(() => {
  seq = 0;
  h.messages = [];
  h.chats = [chat];
  h.activity = {};
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

const answer = (extra: Record<string, unknown> = {}, text = "Cluster looks healthy.") =>
  msg("ans-0001", "dev-ops", {
    type: "text",
    text,
    reply_to: "root-0001",
    meta: {
      tools: ["cluster_health", "metric_trend"],
      read: 14,
      model: "gemma-4b",
      local: true,
      ms: 18_400,
      trace: [
        { kind: "thinking", text: "weighing the disk trend" },
        {
          kind: "tool",
          name: "cluster_health",
          args: '{"zone":"eu"}',
          result: "3 nodes up",
          ms: 412,
        },
      ],
      ...extra,
    },
  });
const root = () => msg("root-0001", "dev-ana", { type: "text", text: "@Ops status?" });

const thread = () => ui(<ThreadView chatId={chat.id} rootId="root-0001" />);

it("renders an agent answer with AI chip, receipts footer, expandable tool step and reasoning", async () => {
  h.messages = [root(), answer()];
  thread();
  expect(screen.getByText("AI")).toBeTruthy();
  expect(screen.getByText("Workspace agent")).toBeTruthy();
  expect(screen.getByText("2 tools")).toBeTruthy();

  const footer = screen.getByRole("button", {
    name: "Read 14 messages · cluster_health, metric_trend · gemma-4b · local · 18.4 s",
  });
  expect(screen.queryByText("3 nodes up")).toBeNull();
  await userEvent.click(footer);
  expect(screen.getByText(/"zone":"eu"/)).toBeTruthy();
  expect(screen.getByText("3 nodes up")).toBeTruthy();

  expect(screen.queryByText("weighing the disk trend")).toBeNull();
  await userEvent.click(screen.getByText("Show reasoning"));
  expect(screen.getByText("weighing the disk trend")).toBeTruthy();
});

it("collapses an answer over 8 lines to its first 3 lines until Show more", async () => {
  const lines = [
    "row-a",
    "row-b",
    "row-c",
    "row-d",
    "row-e",
    "row-f",
    "row-g",
    "row-h",
    "row-i",
    "row-j",
  ];
  h.messages = [root(), answer({}, lines.join("\n\n"))];
  thread();
  expect(screen.getByText("row-c")).toBeTruthy();
  expect(screen.queryByText("row-d")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(screen.getByText("row-j")).toBeTruthy();
});

it("sends a 👎 reaction on the agent reply from the Not helpful button", async () => {
  h.messages = [root(), answer()];
  thread();
  await userEvent.click(screen.getByRole("button", { name: "Not helpful" }));
  expect(h.engine.sendReaction).toHaveBeenCalledWith(chat.id, "ans-0001", "👎", "add");
});

it("labels seeded agent history 'example history' without receipts, and intro chips send the prompt", async () => {
  h.messages = [
    msg("seed-0001", "dev-ops", {
      type: "text",
      text: "Node-3 disk is at 91%.",
      meta: {
        seeded: true,
        read: 9,
        model: "gemma-4b",
        local: true,
        ms: 5000,
        tools: ["cluster_health"],
      },
    }),
    msg("intro-001", "dev-ops", {
      type: "text",
      text: "I am Ops, your SRE on call.",
      meta: { chips: ["Is anything about to go wrong?", "Why is db-2 lagging?"] },
    }),
  ];
  ui(<MessageList chat={chat} />);
  expect(screen.getByText("example history")).toBeTruthy();
  expect(screen.queryByText(/Read 9 messages/)).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Why is db-2 lagging?" }));
  expect(h.engine.sendText).toHaveBeenCalledTimes(1);
  const call = h.engine.sendText.mock.calls[0] as unknown as unknown[];
  expect(call[0]).toBe(chat.id);
  expect(call[1]).toBe("@Ops Why is db-2 lagging?");
});

it("shows how many turns are ahead of a queued agent, for this chat level only", () => {
  h.activity = {
    [chat.id]: {
      "dev-ops": {
        ts: Date.now(),
        body: { type: "activity", phase: "queued", ahead: 2, requester: "ana" },
      },
      "dev-x": {
        ts: Date.now(),
        body: {
          type: "activity",
          phase: "queued",
          ahead: 5,
          reply_to: "root-0001",
          requester: "ana",
        },
      },
    },
  };
  ui(<LiveStatus chatId={chat.id} />);
  expect(screen.getByText(/Ops · queued, 2 ahead/)).toBeTruthy();
  expect(screen.queryByText(/5 ahead/)).toBeNull();
});
