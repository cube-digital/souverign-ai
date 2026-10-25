import type { CallInfo, CallMeta } from "@sa/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const callApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../src/call/api", () => ({ callApi }));

import { CallCard } from "../src/call/CallCard";

const info = (over: Partial<CallInfo> = {}): CallInfo => ({
  id: "call-0001",
  chat_id: "chat-0001",
  room: "room-1",
  started_by: "ana",
  started_at: 1_000_000,
  ended_at: null,
  anchor_message_id: null,
  e2ee: false,
  participants: [
    { user_id: "ana", name: "Ana", in_call: true, consent: "accepted" },
    { user_id: "vlad", name: "Vlad", in_call: true, consent: "pending" },
    { user_id: "rares", name: "Rareș", in_call: false, consent: "pending" },
  ],
  notetaker: null,
  ...over,
});

function card(meta: CallMeta) {
  return render(
    <MemoryRouter initialEntries={["/c/chat-0001"]}>
      <Routes>
        <Route path="/c/:chatId" element={<CallCard meta={meta} />} />
        <Route path="/c/:chatId/call/:callId" element={<div>call page opened</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it("a started call shows who is in it and Join opens the call page; an ended call shows its length and Join is disabled", async () => {
  const user = userEvent.setup();
  callApi.get.mockResolvedValue(info());
  card({ call_id: "call-0001", op: "started" });

  expect(await screen.findByText("Ana started a call · 2 in call")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(await screen.findByText("call page opened")).toBeTruthy();
  cleanup();

  callApi.get.mockResolvedValue(info({ ended_at: 1_000_000 + 180_000 }));
  card({ call_id: "call-0001", op: "ended", duration_ms: 180_000 });
  expect(await screen.findByText("Call ended · 3 min")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Join" }) as HTMLButtonElement).disabled).toBe(true);
});
