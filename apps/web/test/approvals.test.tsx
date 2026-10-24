import type { Approval, ApprovalPublic, Question, ServerEvent } from "@sa/protocol";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pending: [] as unknown[],
  all: [] as unknown[],
  grants: [] as unknown[],
  publics: {} as Record<string, unknown>,
  questions: {} as Record<string, unknown>,
}));

vi.mock("../src/api", () => {
  class ApiFailure extends Error {
    constructor(
      readonly status: number,
      readonly body: { error: string },
    ) {
      super(`api ${status}: ${body.error}`);
    }
  }
  return {
    ApiFailure,
    EVENTS_PATH: "/api/events",
    getSession: () => ({ token: "tok-ana", user: { id: "ana", display_name: "Ana" } }),
    approvals: vi.fn(async (q: { status?: string } = {}) =>
      q.status === "all" ? h.all : h.pending,
    ),
    approvalPublic: vi.fn(async (id: string) => h.publics[id]),
    approvalGrants: vi.fn(async () => h.grants),
    decideApproval: vi.fn(),
    cancelApproval: vi.fn(),
    revokeGrant: vi.fn(async () => ({ ok: true })),
    chatNotes: vi.fn(async () => []),
    getQuestion: vi.fn(async (id: string) => h.questions[id]),
    answerQuestion: vi.fn(),
  };
});
vi.mock("../src/state/session", () => ({
  useSession: () => ({ user: { id: "ana", display_name: "Ana" } }),
}));
// Provider contract: openEvents(onEvent, { signal, onOpen }); the mock reports one connect.
vi.mock("../src/lib/sse", () => ({
  openEvents: vi.fn((_on: unknown, opts: { onOpen?: () => void }) => {
    queueMicrotask(() => opts.onOpen?.());
  }),
}));

import * as api from "../src/api";
import { ActionsLog } from "../src/approvals/ActionsLog";
import { ApprovalCard } from "../src/approvals/ApprovalCard";
import { ApprovalSlot } from "../src/approvals/ApprovalSlot";
import { PendingPill } from "../src/approvals/PendingPill";
import { QuestionCard } from "../src/approvals/QuestionCard";
import { ApprovalsProvider } from "../src/approvals/store";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

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
      { key: "subject", label: "Subject", value: "Hello", editable: true, multiline: false },
      { key: "body", label: "Body", value: "Original body", editable: true, multiline: true },
    ],
    leaves_chat: true,
  },
  status: "pending",
  requester_user_id: "bob",
  approver_user_id: "ana",
  approver_name: "Ana",
  decided_by: null,
  decided_at: null,
  created_at: NOW - MIN,
  expires_at: NOW + 60 * MIN,
  result: null,
  auto: false,
  always_allowed: false,
  ...over,
});
const pub = (over: Partial<ApprovalPublic> = {}): ApprovalPublic => ({
  id: "ap1",
  chat_id: "chat-1",
  agent_name: "Ops",
  tool: "email_send",
  status: "pending",
  approver_name: "Bob",
  requester_user_id: "carol",
  ...over,
});
const question = (over: Partial<Question> = {}): Question => ({
  id: "q1",
  agent_id: "ag-ops",
  agent_name: "Ops",
  chat_id: "chat-1",
  reply_to: "msg-1",
  requester_user_id: "ana",
  requester_name: "Ana",
  question: "When should I send it?",
  options: ["Tomorrow", "Friday"],
  status: "open",
  answer: null,
  created_at: NOW - MIN,
  expires_at: NOW + 60 * MIN,
  ...over,
});

const mounted = (ui: ReactNode) => (
  <MemoryRouter>
    <ApprovalsProvider>{ui}</ApprovalsProvider>
  </MemoryRouter>
);
const settle = () => act(async () => {});

beforeEach(() => {
  h.pending = [];
  h.all = [];
  h.grants = [];
  h.publics = {};
  h.questions = {};
  vi.mocked(api.decideApproval).mockReset();
  vi.mocked(api.cancelApproval).mockReset();
  vi.mocked(api.revokeGrant).mockClear();
  vi.mocked(api.answerQuestion).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openEvents", () => {
  it("parses events split across chunks, ignores pings and invalid events, reconnects after 1 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const enc = new TextEncoder();
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('data: {"type":"hel'));
          c.enqueue(enc.encode('lo","user_id":"ana"}\n\n: ping\n\ndata: {"type":"nope"}\n\n'));
          c.close();
        },
      });
    const fetchMock = vi.fn(async () => new Response(body(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { openEvents } = await vi.importActual<typeof import("../src/lib/sse")>("../src/lib/sse");
    const onEvent = vi.fn<(e: ServerEvent) => void>();
    const onOpen = vi.fn();
    const ctl = new AbortController();

    openEvents(onEvent, { signal: ctl.signal, onOpen });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/events");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok-ana");
    expect(onEvent.mock.calls).toEqual([[{ type: "hello", user_id: "ana" }]]);
    expect(onOpen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledTimes(2);
    ctl.abort();
  });
});

describe("ApprovalCard", () => {
  it("Edit first then Approve and send posts only the editable keys", async () => {
    const user = userEvent.setup();
    vi.mocked(api.decideApproval).mockResolvedValue(approval({ status: "approved" }));
    render(mounted(<ApprovalCard approval={approval()} />));
    await settle();

    const card = screen.getByRole("region", { name: "Approval" });
    expect(card.textContent).toContain("Ops wants to: Reply to Dana");
    expect(card.textContent).toContain("Only you see this card.");
    expect(card.textContent).toContain(
      "Nothing leaves this Mac: the email is saved to the local outbox.",
    );
    await user.click(screen.getByRole("button", { name: "Edit first" }));
    const bodyBox = screen.getByRole("textbox", { name: "Body" });
    await user.clear(bodyBox);
    await user.type(bodyBox, "Edited body");
    await user.click(screen.getByRole("button", { name: "Approve and send" }));

    expect(api.decideApproval).toHaveBeenCalledTimes(1);
    const [id, decision] = vi.mocked(api.decideApproval).mock.calls[0];
    expect(id).toBe("ap1");
    expect(decision.decision).toBe("approve");
    expect(decision.args?.body).toBe("Edited body");
    expect(decision.args).not.toHaveProperty("to");
  });

  it("Deny calls decideApproval with deny, then shows Declined and no buttons", async () => {
    const user = userEvent.setup();
    vi.mocked(api.decideApproval).mockResolvedValue(
      approval({ status: "denied", decided_by: "ana", decided_at: NOW }),
    );
    render(mounted(<ApprovalCard approval={approval()} />));
    await settle();

    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(vi.mocked(api.decideApproval).mock.calls[0][0]).toBe("ap1");
    expect(vi.mocked(api.decideApproval).mock.calls[0][1].decision).toBe("deny");
    expect(await screen.findByText("Declined")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve and send" })).toBeNull();
  });

  it("counts down to Expired and disables the buttons", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const a = approval({ expires_at: NOW + (11 * 60 + 40) * MIN });
    render(mounted(<ApprovalCard approval={a} />));
    await settle();
    expect(screen.getByText("Expires in 11 h 40 min")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime((11 * 60 + 35) * MIN);
    });
    expect(screen.getByText("Expires in 5:00")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("Expires in 4:59")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(4 * MIN + 59_000);
    });
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Approve and send" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("offers the always checkbox only when allowed", async () => {
    const { rerender } = render(mounted(<ApprovalCard approval={approval()} />));
    await settle();
    expect(screen.queryByRole("checkbox")).toBeNull();

    rerender(mounted(<ApprovalCard approval={approval({ always_allowed: true })} />));
    await settle();
    expect(
      screen.getByRole("checkbox", { name: "Always approve email_send for Ops" }),
    ).toBeTruthy();
  });

  it("renders an unknown tool generically with Approve, and Cancel when I am approver and requester", async () => {
    const user = userEvent.setup();
    vi.mocked(api.cancelApproval).mockResolvedValue(approval({ status: "canceled" }));
    const a = approval({ tool: "crm_update_deal", requester_user_id: "ana" });
    render(mounted(<ApprovalCard approval={a} />));
    await settle();

    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(api.cancelApproval).toHaveBeenCalledWith("ap1");
    expect(api.decideApproval).not.toHaveBeenCalled();
  });
});

describe("approvals around the card", () => {
  it("pill counts only my pending actions and opens a compact card with a thread link", async () => {
    const user = userEvent.setup();
    h.pending = [
      approval(),
      approval({ id: "ap2", approver_user_id: "bob", approver_name: "Bob" }),
      approval({ id: "ap3", status: "denied" }),
    ];
    render(mounted(<PendingPill />));

    const pill = await screen.findByRole("button", { name: "1 action waiting for you" });
    await user.click(pill);

    const link = await screen.findByRole("link", { name: "Open thread" });
    expect(link.getAttribute("href")).toBe("/c/chat-1/t/msg-1");
  });

  it("slot: approver sees the card, others a waiting chip, only a non-approver requester gets Cancel request", async () => {
    const user = userEvent.setup();
    h.pending = [approval({ id: "a1" })];
    h.publics = {
      a2: pub({ id: "a2", approver_name: "Bob", requester_user_id: "carol" }),
      a3: pub({ id: "a3", approver_name: "Bob", requester_user_id: "ana" }),
    };
    vi.mocked(api.cancelApproval).mockResolvedValue(pub({ id: "a3", status: "canceled" }));
    render(mounted(<ApprovalSlot ids={["a1", "a2", "a3"]} />));

    expect(await screen.findAllByText("Waiting for Bob · email_send")).toHaveLength(2);
    const cards = screen.getAllByRole("region", { name: "Approval" });
    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByRole("button", { name: "Approve and send" })).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel request" });

    await user.click(cancel);
    expect(api.cancelApproval).toHaveBeenCalledWith("a3");
  });

  it("actions log lists this agent's rows and revokes a grant", async () => {
    const user = userEvent.setup();
    h.all = [approval({ status: "executed", result: "Saved to outbox", decided_by: "ana" })];
    h.grants = [
      { agent_id: "ag-ops", agent_name: "Ops", tool: "email_send", created_at: NOW },
      { agent_id: "ag-other", agent_name: "Other", tool: "notes_create", created_at: NOW },
    ];
    render(mounted(<ActionsLog agentId="ag-ops" />));

    expect(await screen.findByText("Saved to outbox")).toBeTruthy();
    expect(api.approvals).toHaveBeenCalledWith({ status: "all", agent_id: "ag-ops" });
    const stop = await screen.findAllByRole("button", { name: "Stop auto-approving" });
    expect(stop).toHaveLength(1);

    await user.click(stop[0]);
    expect(api.revokeGrant).toHaveBeenCalledWith("ag-ops", "email_send");
  });
});

describe("QuestionCard", () => {
  it("requester answers with an option; others only see Waiting for the requester", async () => {
    const user = userEvent.setup();
    h.questions = {
      q1: question(),
      q2: question({ id: "q2", requester_user_id: "bob", requester_name: "Bob" }),
    };
    vi.mocked(api.answerQuestion).mockResolvedValue(
      question({ status: "answered", answer: "Friday" }),
    );
    const props = { text: "When should I send it?", options: ["Tomorrow", "Friday"] };
    const { unmount } = render(mounted(<QuestionCard questionId="q1" {...props} />));

    expect(await screen.findByLabelText("Or type an answer")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Friday" }));
    expect(api.answerQuestion).toHaveBeenCalledWith("q1", { option: 1 });
    expect(await screen.findByText("Answered by Ana: Friday")).toBeTruthy();
    unmount();

    render(mounted(<QuestionCard questionId="q2" {...props} />));
    expect(await screen.findByText("Waiting for Bob to answer")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Friday" })).toBeNull());
    expect(screen.queryByLabelText("Or type an answer")).toBeNull();
  });
});
