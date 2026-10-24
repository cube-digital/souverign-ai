import type { Approval } from "@sa/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pending: [] as unknown[],
  onOpen: null as null | (() => void),
}));

vi.mock("../src/api", () => ({
  ApiFailure: class extends Error {},
  EVENTS_PATH: "/api/events",
  getSession: () => ({ token: "t", user: { id: "ana", display_name: "Ana" } }),
  approvals: vi.fn(async () => h.pending),
  approvalPublic: vi.fn(async (id: string) => ({
    id,
    chat_id: "c",
    agent_name: "Ops",
    tool: "email_send",
    status: "approved",
    approver_name: "Ana",
    requester_user_id: "bob",
  })),
  getQuestion: vi.fn(),
}));
vi.mock("../src/state/session", () => ({
  useSession: () => ({ user: { id: "ana", display_name: "Ana" } }),
}));
vi.mock("../src/lib/sse", () => ({
  openEvents: vi.fn((_on: unknown, opts: { onOpen?: () => void }) => {
    h.onOpen = opts.onOpen ?? null;
    queueMicrotask(() => opts.onOpen?.());
  }),
}));

import { PendingPill } from "../src/approvals/PendingPill";
import { ApprovalsProvider } from "../src/approvals/store";

const ap = (id: string): Approval => ({
  id,
  agent_id: "a",
  agent_name: "Ops",
  chat_id: "c",
  chat_title: "t",
  reply_to: "m",
  kind: "tool",
  tool: "email_send",
  args: {},
  preview: { title: "x", target: "", fields: [], leaves_chat: false },
  status: "pending",
  requester_user_id: "bob",
  approver_user_id: "ana",
  approver_name: "Ana",
  decided_by: null,
  decided_at: null,
  created_at: 1,
  expires_at: Date.now() + 3_600_000,
  result: null,
  auto: false,
  always_allowed: false,
});

afterEach(cleanup);

describe("reconnect reconcile", () => {
  it("drops approvals the server no longer lists as pending after a reconnect", async () => {
    h.pending = [ap("a1"), ap("a2")];
    render(
      <MemoryRouter>
        <ApprovalsProvider>
          <PendingPill />
        </ApprovalsProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("button", { name: "2 actions waiting for you" })).toBeTruthy();

    h.pending = [ap("a2")];
    await act(async () => {
      h.onOpen?.();
    });
    expect(await screen.findByRole("button", { name: "1 action waiting for you" })).toBeTruthy();
  });
});

describe("openEvents idle timeout", () => {
  it("reconnects when no bytes arrive within the idle window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              init.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
            },
          });
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          resolve(new Response(body, { status: 200 }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { openEvents, IDLE_MS } =
      await vi.importActual<typeof import("../src/lib/sse")>("../src/lib/sse");
    const ctl = new AbortController();
    openEvents(() => {}, { signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    ctl.abort();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
