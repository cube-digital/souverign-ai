import type { CallInfo } from "@sa/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

const callApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../src/call/api", () => ({ callApi }));

import { CallCard } from "../src/call/CallCard";
import { type BridgeEvent, dispatchBridgeEvent } from "../src/lib/bridge-events";

const info = (over: Partial<CallInfo> = {}): CallInfo => ({
  id: "call-0001",
  chat_id: "chat-0001",
  room: "room-1",
  started_by: "ana",
  started_at: 1_000_000,
  ended_at: null,
  anchor_message_id: null,
  e2ee: false,
  participants: [{ user_id: "ana", name: "Ana", in_call: true, consent: "accepted" }],
  notetaker: null,
  ...over,
});

afterEach(cleanup);

it("the started-call card turns into Call ended when the call ends after everyone left", async () => {
  callApi.get.mockResolvedValue(info());
  render(
    <MemoryRouter>
      <CallCard meta={{ call_id: "call-0001", op: "started" }} />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Ana started a call · 1 in call")).toBeTruthy();
  act(() =>
    dispatchBridgeEvent({
      type: "call.updated",
      call: info({ ended_at: 1_000_000 + 240_000 }),
    } as BridgeEvent),
  );
  expect(screen.getByText("Call ended · 4 min")).toBeTruthy();
});
