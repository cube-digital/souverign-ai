import type { Approval, Chat } from "@sa/protocol";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const DM: Chat = {
  id: "dm-ana-scribe",
  title: "Scribe",
  kind: "dm",
  created_by: "ana",
  key_epoch: 1,
  members: [
    { member_type: "user", member_id: "ana", devices: [] },
    { member_type: "agent", member_id: "scribe", devices: [] },
  ],
} as unknown as Chat;

const h = vi.hoisted(() => ({
  onEvent: null as null | ((e: unknown) => void),
  agentDm: vi.fn(),
  claimEpoch: vi.fn(),
  createEpoch: vi.fn(async () => {}),
  latestEpoch: vi.fn(async () => 0),
}));

vi.mock("../src/api", () => ({
  ApiFailure: class extends Error {},
  approvals: vi.fn(async () => []),
  approvalPublic: vi.fn(async () => null),
  cancelApproval: vi.fn(),
  decideApproval: vi.fn(),
  getQuestion: vi.fn(),
  agentDm: h.agentDm,
  claimEpoch: h.claimEpoch,
}));
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    user: { id: "ana", display_name: "Ana" },
    chats: [DM],
    refreshChats: async () => [DM],
    engine: { latestEpoch: h.latestEpoch, createEpoch: h.createEpoch },
  }),
}));
vi.mock("../src/lib/sse", () => ({
  openEvents: vi.fn((on: (e: unknown) => void) => {
    h.onEvent = on;
  }),
}));

import { ApprovalsProvider } from "../src/approvals/store";

const ap = (id: string, status: Approval["status"]): Approval =>
  ({ id, chat_id: DM.id, status, agent_id: "scribe", tool: "call_notes_publish" }) as Approval;

afterEach(cleanup);

it("approval events for one agent DM in the same tick key it once, and only pending ones key it", async () => {
  h.agentDm.mockImplementation(async () => DM);
  render(
    <ApprovalsProvider>
      <span />
    </ApprovalsProvider>,
  );
  await act(async () => {
    h.onEvent?.({ type: "approval", approval: ap("a1", "pending") });
    h.onEvent?.({ type: "approval", approval: ap("a1", "pending") });
    h.onEvent?.({ type: "approval", approval: ap("a2", "pending") });
  });
  await vi.waitFor(() => expect(h.createEpoch).toHaveBeenCalledTimes(1));
  expect(h.agentDm).toHaveBeenCalledTimes(1);

  // decided, expired and replayed events do not start another run
  await act(async () => {
    h.onEvent?.({ type: "approval", approval: ap("a1", "executed") });
    h.onEvent?.({ type: "approval", approval: ap("a2", "expired") });
  });
  expect(h.agentDm).toHaveBeenCalledTimes(1);
  expect(h.createEpoch).toHaveBeenCalledTimes(1);
  expect(h.claimEpoch).not.toHaveBeenCalled();
});
