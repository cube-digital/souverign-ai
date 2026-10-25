import type { Agent, Approval, ApprovalGrant, Chat, KnowledgeItemDetail } from "@sa/protocol";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pending: [] as unknown[],
  railOpen: vi.fn(),
}));

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ApiFailure: actual.ApiFailure,
    EVENTS_PATH: "/api/events",
    getSession: () => ({ token: "tok-ana", user: { id: "ana", display_name: "Ana" } }),
    agents: vi.fn(async () => []),
    routines: vi.fn(async () => []),
    getPrefs: vi.fn(async () => ({ pause_all: false, time_zone: "Europe/Zurich" })),
    knowledge: vi.fn(async () => []),
    lessons: vi.fn(async () => []),
    knowledgeItem: vi.fn(),
    teachDocument: vi.fn(),
    deleteKnowledge: vi.fn(),
    addLesson: vi.fn(),
    deleteLesson: vi.fn(),
    setSharing: vi.fn(),
    approvals: vi.fn(async (q: { status?: string } = {}) => (q.status === "all" ? [] : h.pending)),
    approvalPublic: vi.fn(async () => undefined),
    approvalGrants: vi.fn(async () => []),
    decideApproval: vi.fn(),
    cancelApproval: vi.fn(),
    revokeGrant: vi.fn(),
    chatNotes: vi.fn(async () => []),
    getQuestion: vi.fn(),
    answerQuestion: vi.fn(),
  };
});
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    user: { id: "ana", display_name: "Ana" },
    chats: [],
    messages: {},
    unread: {},
    engine: {},
    refreshChats: async () => [],
  }),
  useActivity: () => ({}),
}));
vi.mock("../src/lib/sse", () => ({
  openEvents: vi.fn((_on: unknown, opts: { onOpen?: () => void }) => {
    queueMicrotask(() => opts.onOpen?.());
  }),
}));
vi.mock("../src/shell/rail", () => ({
  useRail: () => ({ panel: null, open: h.railOpen, close: () => {} }),
}));

import { AgentProfilePage } from "../src/agents/AgentProfilePage";
import * as api from "../src/api";
import { ApprovalsProvider } from "../src/approvals/store";
import { AgentMessage } from "../src/channel/AgentMessage";
import { ChannelHeader } from "../src/channel/ChannelHeader";
import { expandSlash, SLASH_COMMANDS } from "../src/composer/slash";
import { ToastProvider } from "../src/ds";
import { TopBar } from "../src/shell/TopBar";

const NOW = 1_800_000_000_000;
const approval = (over: Partial<Approval> = {}): Approval => ({
  id: "ap1",
  agent_id: "ag-ops",
  agent_name: "Ops",
  chat_id: "chat-1",
  chat_title: "release",
  reply_to: "msg-1",
  kind: "tool",
  tool: "email_send",
  args: {},
  preview: {
    title: "Reply to Dana",
    target: "dana@example.com",
    fields: [
      { key: "to", label: "To", value: "dana@example.com", editable: false, multiline: false },
    ],
    leaves_chat: true,
  },
  status: "pending",
  requester_user_id: "bob",
  approver_user_id: "ana",
  approver_name: "Ana",
  decided_by: null,
  decided_at: null,
  created_at: NOW - 60_000,
  expires_at: NOW + 3_600_000,
  result: null,
  auto: false,
  always_allowed: false,
  ...over,
});

const nora: Agent = {
  id: "ag-nora",
  name: "Nora",
  template: "general",
  soul: "",
  owner_user_id: "ana",
  device_id: "dev-nora",
  status: "running",
  scope: "personal",
  roster_id: null,
  share_private_in_chats: "always",
};
const detail: KnowledgeItemDetail = {
  id: "x",
  agent_id: "ag-nora",
  kind: "document",
  title: "Supplier contract.pdf",
  mime: "application/pdf",
  size: 1000,
  parts: 1,
  truncated: false,
  tags: [],
  origin_chat_id: null,
  origin_chat_title: null,
  taught_by_user_id: "ana",
  taught_by_name: "Ana",
  created_at: NOW,
  preview: "Payment within 30 days",
  segments: [{ label: null, text: "Payment within 30 days of invoice" }],
};

const mounted = (ui: ReactNode, at = "/") => (
  <MemoryRouter initialEntries={[at]}>
    <ToastProvider>
      <ApprovalsProvider>{ui}</ApprovalsProvider>
    </ToastProvider>
  </MemoryRouter>
);

beforeEach(() => {
  h.pending = [];
  vi.clearAllMocks();
  vi.mocked(api.agents).mockResolvedValue([nora]);
  vi.mocked(api.knowledge).mockResolvedValue([]);
  vi.mocked(api.lessons).mockResolvedValue([]);
  vi.mocked(api.knowledgeItem).mockResolvedValue(detail);
});
afterEach(cleanup);

it("the agent profile has Knowledge and Approvals tabs, and ?tab=knowledge&item=x opens the source viewer", async () => {
  render(
    mounted(
      <Routes>
        <Route path="/agents/:agentId" element={<AgentProfilePage />} />
      </Routes>,
      "/agents/ag-nora?tab=knowledge&item=x",
    ),
  );

  expect(await screen.findByRole("tab", { name: "Knowledge" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Approvals" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Knowledge" }).getAttribute("aria-selected")).toBe("true");
  const viewer = await screen.findByRole("dialog");
  expect(await within(viewer).findByText("Payment within 30 days of invoice")).toBeTruthy();
  expect(api.knowledgeItem).toHaveBeenCalledWith("ag-nora", "x");
});

it("the profile Overview lists the memory line and the gated writes from GATED_TOOLS", async () => {
  render(
    mounted(
      <Routes>
        <Route path="/agents/:agentId" element={<AgentProfilePage />} />
      </Routes>,
      "/agents/ag-nora",
    ),
  );
  expect(await screen.findByText(/Memory: remembers this chat since it joined/)).toBeTruthy();
  expect(screen.getByText(/Writes \(need approval\):.*chat_send.*notes_create/)).toBeTruthy();
});

it("the top bar shows the pending pill when one approval waits for me", async () => {
  h.pending = [approval()];
  render(
    mounted(<TopBar onToggleRelay={() => {}} onOpenPalette={() => {}} onSwitchUser={() => {}} />),
  );
  expect(await screen.findByRole("button", { name: "1 action waiting for you" })).toBeTruthy();
});

it("an agent reply with meta.approvals renders the approval card for its approver", async () => {
  h.pending = [approval({ id: "ap1" })];
  render(
    mounted(
      <AgentMessage
        body={{ type: "text", text: "I drafted the reply.", meta: { approvals: ["ap1"] } }}
        member={{
          member_type: "agent",
          member_id: "ag-ops",
          display_name: "Ops",
          role: "member",
          devices: [],
        }}
        time="10:00"
        reactions={undefined}
        onReact={() => {}}
        onChip={() => {}}
      />,
    ),
  );
  await act(async () => {});
  const card = await screen.findByRole("region", { name: "Approval" });
  expect(card.textContent).toContain("Ops wants to: Reply to Dana");
});

it("the header Notes button opens the notes rail for this chat", async () => {
  const chat: Chat = {
    id: "chat-1",
    title: "release",
    kind: "room",
    created_by: "ana",
    members: [],
  };
  render(mounted(<ChannelHeader chat={chat} />));
  await userEvent.click(screen.getByRole("button", { name: "Notes" }));
  expect(h.railOpen).toHaveBeenCalledWith({ kind: "notes", chatId: "chat-1" });
});

it("/forget expands client-side to a visible '@Agent forget ...' request", () => {
  const ctx = {
    inThread: false,
    agents: [
      { name: "Tech", inChat: true },
      { name: "Ops", inChat: true },
    ],
  };
  expect(expandSlash("/forget Tech the old price list", ctx)).toEqual({
    text: "@Tech forget the old price list",
  });
  expect(
    expandSlash("/forget the old price list", {
      inThread: false,
      agents: [{ name: "Tech", inChat: true }],
    }),
  ).toEqual({ text: "@Tech forget the old price list" });
  expect(SLASH_COMMANDS.map((c) => c.name)).toContain("/forget");
});

it("toolTiers: email_send needs approval, notes_create is always approved with a grant, memory_recall is free", async () => {
  // loaded by variable so a missing module fails this test only, not the whole file
  const path = new URL("../src/agents/toolTiers.ts", import.meta.url).pathname;
  const { toolTiers } = (await import(/* @vite-ignore */ path)) as {
    toolTiers: (
      template: string,
      grants: ApprovalGrant[],
    ) => { tool: string; tier: string; note?: string }[];
  };
  const tiers = (template: string, grants: ApprovalGrant[]) =>
    Object.fromEntries(toolTiers(template, grants).map((t) => [t.tool, t.tier]));

  expect(tiers("sales", [])).toMatchObject({
    email_send: "needs approval",
    memory_recall: "free",
    ask_user: "free",
    chat_read: "free",
  });
  const grant = { agent_id: "ag-nora", agent_name: "Nora", tool: "notes_create", created_at: NOW };
  expect(tiers("general", [grant])).toMatchObject({
    notes_create: "always approved",
    chat_send: "needs approval",
  });
  expect(tiers("general", [])).toMatchObject({ notes_create: "needs approval" });
  expect(toolTiers("general", []).find((t) => t.tool === "memory_forget")?.note).toBe(
    "needs approval if someone else taught it",
  );
});
