import type { Approval } from "@sa/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ all: [] as unknown[] }));
vi.mock("../src/api", () => ({
  ApiFailure: class extends Error {},
  EVENTS_PATH: "/api/events",
  getSession: () => ({ token: "tok-ana", user: { id: "ana", display_name: "Ana" } }),
  approvals: vi.fn(async (q: { status?: string } = {}) => (q.status === "all" ? h.all : [])),
  approvalPublic: vi.fn(),
  approvalGrants: vi.fn(async () => []),
  decideApproval: vi.fn(async () => ({ ok: true })),
  cancelApproval: vi.fn(),
  getQuestion: vi.fn(),
}));
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    user: { id: "ana", display_name: "Ana" },
    chats: [],
    refreshChats: async () => [],
    engine: null,
  }),
}));
vi.mock("../src/lib/sse", () => ({ openEvents: vi.fn() }));

import * as api from "../src/api";
import { NotesApprovals } from "../src/app/ChannelPage";
import { ApprovalsProvider } from "../src/approvals/store";

const notes = (over: Partial<Approval>): Approval =>
  ({
    id: "ap-notes",
    agent_id: "ag-scribe",
    agent_name: "Scribe",
    chat_id: "dm-scribe",
    chat_title: "Scribe",
    reply_to: null,
    kind: "tool",
    tool: "call_notes_publish",
    args: {},
    preview: {
      title: "Post call notes in #Sync",
      target: "#Sync · call thread",
      fields: [{ key: "text", label: "Notes", value: "x", editable: false, multiline: true }],
      leaves_chat: true,
    },
    status: "pending",
    requester_user_id: "ana",
    approver_user_id: "ana",
    approver_name: "Ana",
    decided_by: null,
    decided_at: null,
    created_at: Date.now(),
    expires_at: Date.now() + 3_600_000,
    result: null,
    auto: false,
    always_allowed: false,
    ...over,
  }) as Approval;

afterEach(cleanup);

it("shows the inviter's call-notes request in her DM, with Deny although she is also the requester", async () => {
  h.all = [notes({}), notes({ id: "ap-old", status: "denied", created_at: 1 })];
  render(
    <MemoryRouter>
      <ApprovalsProvider>
        <NotesApprovals chatId="dm-scribe" />
      </ApprovalsProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  const cards = screen.getAllByRole("region", { name: "Approval" });
  expect(cards).toHaveLength(1);
  expect(cards[0]?.textContent).toContain("Post call notes in #Sync");
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(api.decideApproval).toHaveBeenCalled();
});
