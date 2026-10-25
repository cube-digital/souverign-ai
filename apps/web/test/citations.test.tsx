import type { ChatMessage } from "@sa/client";
import type { Chat, ChatMember, Citation } from "@sa/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  chats: [] as unknown[],
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
    useActivity: () => ({}),
  };
});
vi.mock("../src/shell/rail", () => ({
  useRail: () => ({ panel: null, open: vi.fn(), close: () => {} }),
}));
vi.mock("../src/api", () => ({
  stopTurn: vi.fn(),
  agents: vi.fn(async () => []),
  sendCorrection: vi.fn(async () => ({})),
  approvals: vi.fn(async () => []),
  approvalPublic: vi.fn(async () => undefined),
  approvalGrants: vi.fn(async () => []),
  getSession: () => ({ token: "tok", user: { id: "ana", display_name: "Ana" } }),
  EVENTS_PATH: "/api/events",
}));
vi.mock("../src/lib/sse", () => ({
  openEvents: vi.fn((_on: unknown, opts: { onOpen?: () => void }) => {
    queueMicrotask(() => opts.onOpen?.());
  }),
}));

import * as api from "../src/api";
import { ApprovalsProvider } from "../src/approvals/store";
import { AgentMessage } from "../src/channel/AgentMessage";
import { MessageList } from "../src/channel/MessageList";
import { ThreadView } from "../src/channel/ThreadView";
import { ToastProvider } from "../src/ds";

const dev = (id: string) => ({ device_id: id, public_key: "k" });
const opsMember: ChatMember = {
  member_type: "agent",
  member_id: "ag-ops",
  display_name: "Ops",
  role: "member",
  agent_scope: "workspace",
  devices: [dev("dev-ops")],
};
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
    opsMember,
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

const cite = (over: Partial<Citation>): Citation => ({
  n: 1,
  space: "agent",
  kind: "knowledge",
  source_type: "doc",
  source_id: "s1",
  title: "Supplier contract.pdf",
  ts: 1_800_000_000_000,
  agent_id: "a",
  item_id: "i",
  cited: true,
  ...over,
});

function Where() {
  const l = useLocation();
  return <output aria-label="location">{`${l.pathname}${l.search}`}</output>;
}
const shell = (node: ReactNode, at = "/start") => (
  <MemoryRouter initialEntries={[at]}>
    <ToastProvider>
      <ApprovalsProvider>
        <Routes>
          <Route
            path="*"
            element={
              <>
                {node}
                <Where />
              </>
            }
          />
        </Routes>
      </ApprovalsProvider>
    </ToastProvider>
  </MemoryRouter>
);
const agentMsg = (meta: Record<string, unknown>, text = "Answer text.") => (
  <AgentMessage
    body={{ type: "text", text, meta }}
    member={opsMember}
    time="10:00"
    reactions={undefined}
    onReact={() => {}}
    onChip={() => {}}
  />
);
const chipOf = (n: number) =>
  screen.getByText(
    (_, el) => /^(A|BUTTON)$/.test(el?.tagName ?? "") && !!el?.textContent?.includes(`[${n}]`),
  );

beforeEach(() => {
  seq = 0;
  h.messages = [];
  h.chats = [chat];
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("renders one chip per citation ordered by n; only the uncited ones are muted 'Read, not cited'", () => {
  const citations = [
    cite({ n: 2, title: "Old thread", cited: false, source_type: "message", space: "chat" }),
    cite({ n: 1, title: "Supplier contract.pdf", cited: true }),
  ];
  render(shell(agentMsg({ citations })));

  const first = chipOf(1);
  const second = chipOf(2);
  expect(first.textContent).toContain("Supplier contract.pdf");
  expect(second.textContent).toContain("Old thread");
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getAllByTitle("Read, not cited")).toEqual([second]);
  expect(first.getAttribute("title")).not.toBe("Read, not cited");
});

it("a chat source chip opens /c/<chat>?m=<message>, an agent source chip opens the knowledge item", async () => {
  const user = userEvent.setup();
  const citations = [
    cite({
      n: 1,
      space: "chat",
      kind: "conversation",
      source_type: "message",
      title: "Release thread",
      chat_id: "x",
      message_id: "y",
    }),
    cite({ n: 2, agent_id: "a", item_id: "i", title: "Price list.pdf" }),
  ];
  render(shell(agentMsg({ citations })));

  await user.click(chipOf(1));
  expect(screen.getByLabelText("location").textContent).toBe("/c/x?m=y");

  await user.click(chipOf(2));
  expect(screen.getByLabelText("location").textContent).toBe("/agents/a?tab=knowledge&item=i");
});

it("👎 opens the correction prompt; sending posts chat and message ids and thanks the user by agent name", async () => {
  const user = userEvent.setup();
  h.messages = [
    msg("root-0001", "dev-ana", { type: "text", text: "@Ops what is the price?" }),
    msg("ans-0001", "dev-ops", {
      type: "text",
      text: "It is 40 CHF.",
      reply_to: "root-0001",
      meta: { read: 3, model: "gemma-4b", local: true, ms: 1000 },
    }),
  ];
  render(shell(<ThreadView chatId={chat.id} rootId="root-0001" />));

  expect(screen.queryByPlaceholderText("What should it have said?")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Not helpful" }));
  expect(h.engine.sendReaction).toHaveBeenCalledWith(chat.id, "ans-0001", "👎", "add");

  await user.type(
    screen.getByPlaceholderText("What should it have said?"),
    "It is 45 CHF since March.",
  );
  await user.click(screen.getByRole("button", { name: "Send correction" }));

  expect(api.sendCorrection).toHaveBeenCalledTimes(1);
  expect(api.sendCorrection).toHaveBeenCalledWith("ag-ops", {
    chat_id: chat.id,
    message_id: "ans-0001",
    text: "It is 45 CHF since March.",
  });
  expect(await screen.findByText("Thanks. Ops will use this correction.")).toBeTruthy();
});

it("a held answer is a muted 'Private preview' notice, not a plain reply", () => {
  render(shell(agentMsg({ held: "ap9" }, "Draft with private details.")));
  expect(screen.getByText("Private preview")).toBeTruthy();
  expect(screen.getByText("Draft with private details.")).toBeTruthy();
});

it("renders an approval stamp with its status and an 'Approved by <name>' chip", () => {
  render(
    shell(
      agentMsg(
        { approval: { id: "ap1", status: "executed" }, approved_by: "Dana" },
        "Email sent to the supplier.",
      ),
    ),
  );
  expect(screen.getByText("Approved by Dana")).toBeTruthy();
  expect(screen.getByText(/executed/i)).toBeTruthy();
});

it("?m=<id> scrolls that message into view and highlights only it for 2 s", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  h.messages = [
    msg("m-other-1", "dev-ana", { type: "text", text: "Unrelated lunch plans" }),
    msg("m-target", "dev-ana", { type: "text", text: "Supplier pays within thirty days" }),
  ];
  render(shell(<MessageList chat={chat} />, `/c/${chat.id}?m=m-target`));
  await act(async () => {});

  const lit = Array.from(document.querySelectorAll('[data-highlight="true"]'));
  expect(lit).toHaveLength(1);
  expect(lit[0]?.textContent).toContain("Supplier pays within thirty days");
  expect(lit[0]?.textContent).not.toContain("Unrelated lunch plans");
  expect(scroll).toHaveBeenCalled();

  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(document.querySelectorAll('[data-highlight="true"]')).toHaveLength(0);
});
