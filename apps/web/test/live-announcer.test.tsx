import type { Chat } from "@sa/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ activity: {} as Record<string, Record<string, unknown>> }));
vi.mock("../src/state/session", () => ({
  useSession: () => ({ user: { id: "ana" }, chats: [] }),
  useActivity: () => h.activity,
}));
vi.mock("../src/api", () => ({ stopTurn: vi.fn(), agents: vi.fn(async () => []) }));

import { LiveAnnouncer } from "../src/channel/LiveStatus";

const chat: Chat = {
  id: "c1",
  title: "general",
  kind: "room",
  created_by: "ana",
  members: [
    {
      member_type: "agent",
      member_id: "ag-s",
      display_name: "Scribe",
      role: "member",
      devices: [{ device_id: "dev-scribe", public_key: "k" }],
    },
  ],
};
afterEach(cleanup);

it("announces phase and queue position, never the streamed draft", () => {
  h.activity = {
    c1: {
      "dev-scribe": {
        ts: 1,
        body: { type: "activity", phase: "writing", draft: "secret half sentence" },
      },
    },
  };
  const { rerender } = render(<LiveAnnouncer chat={chat} />);
  const region = screen.getByRole("status");
  expect(region.textContent).toBe("Scribe is writing");
  h.activity = {
    c1: { "dev-scribe": { ts: 2, body: { type: "activity", phase: "queued", ahead: 2 } } },
  };
  rerender(<LiveAnnouncer chat={chat} />);
  expect(screen.getByRole("status").textContent).toBe("Scribe: queued, 2 ahead");
});
