import type { Chat } from "@sa/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  release: null as null | (() => void),
  engine: { sendText: vi.fn(), sendFile: vi.fn() },
}));

vi.mock("../src/state/session", () => ({
  useSession: () => ({
    user: { id: "ana", display_name: "Ana" },
    engine: h.engine,
    refreshChats: async () => [],
  }),
  useActivity: () => ({}),
}));
vi.mock("../src/api", () => ({ agents: vi.fn(async () => []) }));
vi.mock("../src/state/membership", () => ({ addAgentWithKey: vi.fn() }));

import { Composer } from "../src/composer/Composer";

const chat: Chat = {
  id: "chat-room01",
  title: "general",
  kind: "room",
  created_by: "ana",
  members: [
    {
      member_type: "user",
      member_id: "ana",
      display_name: "Ana",
      role: "owner",
      devices: [{ device_id: "dev-ana", public_key: "k" }],
    },
  ],
};
const box = () => screen.getByRole("textbox", { name: "Message # general" }) as HTMLTextAreaElement;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

it("applies a new prefill key to an already mounted composer", () => {
  const { rerender } = render(<Composer chat={chat} prefill={{ key: "k1", text: "@Ops " }} />);
  expect(box().value).toBe("@Ops ");
  rerender(<Composer chat={chat} prefill={{ key: "k2", text: "@Scribe ", quote: "q" }} />);
  expect(box().value).toBe("@Scribe ");
});

it("keeps text typed while a send is in flight", async () => {
  h.engine.sendText.mockImplementation(
    () =>
      new Promise<void>((r) => {
        h.release = r;
      }),
  );
  render(<Composer chat={chat} />);
  await userEvent.type(box(), "first{Enter}");
  await waitFor(() => expect(h.engine.sendText).toHaveBeenCalledTimes(1));
  await userEvent.type(box(), "second");
  h.release?.();
  await waitFor(() => expect(h.release).not.toBeNull());
  await waitFor(() => expect(box().value).toBe("firstsecond"));
});
