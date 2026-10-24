import type { Agent, Chat } from "@sa/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const scribe: Agent = {
  id: "ag-scribe",
  name: "Scribe",
  template: "scribe",
  soul: "",
  owner_user_id: null,
  device_id: "dev-scribe",
  status: "running",
  scope: "workspace",
  roster_id: "scribe",
};
const device = { id: "dev-scribe", public_key: "pk" };
const dm = {
  id: "dm-scribe",
  title: "Scribe",
  kind: "dm",
  created_by: "ana",
  members: [
    {
      member_type: "agent",
      member_id: "ag-scribe",
      display_name: "Scribe",
      role: "member",
      devices: [device],
    },
  ],
} as unknown as Chat;
const chat = (id: string, title: string, seed_key?: string): Chat => ({
  id,
  title,
  kind: "room",
  created_by: "ana",
  members: [],
  seed_key,
});
const chats = [chat("c-general", "general", "general"), chat("c-road", "Roadmap")];

const agentDm = vi.fn(async (_id: string) => dm);
vi.mock("../src/api", async (orig) => ({
  ...(await orig<typeof import("../src/api")>()),
  agents: vi.fn(async () => [scribe]),
  agentDm: (id: string) => agentDm(id),
}));

const createEpoch = vi.fn(async (_chatId: string, _devices: unknown[]) => {});
const latestEpoch = vi.fn(async (_chatId: string) => 0);
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    user: { id: "ana", display_name: "Ana" },
    engine: { createEpoch, latestEpoch },
    chats,
    unread: {},
    activity: {},
    messages: {},
    refreshChats: async () => chats,
    openChat: () => {},
  }),
}));

import { ToastProvider } from "../src/ds";
import { needsWelcome } from "../src/onboarding/firstRun";
import { WelcomePage } from "../src/onboarding/WelcomePage";
import { CommandPalette, usePaletteHotkey } from "../src/palette/CommandPalette";

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  localStorage.clear();
  agentDm.mockClear();
  createEpoch.mockClear();
});
afterEach(cleanup);

it("first login shows Meet your team with the trust line and opens a Scribe DM", async () => {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/welcome"]}>
        <WelcomePage />
        <Where />
      </MemoryRouter>
    </ToastProvider>,
  );
  expect(screen.getByText(/Meet your team/)).toBeTruthy();
  expect(
    screen.getByText("Every model runs on this Mac · the relay sees ciphertext only"),
  ).toBeTruthy();
  // one first example prompt per roster agent: six cards
  for (const p of [
    "Is anything about to go wrong?",
    "Is 7.4 ready to ship?",
    "Review this diff",
    "How do we fail over node-1?",
    "Brief me on Northwind before the call",
    "What did I miss?",
  ]) {
    expect(screen.getAllByText(new RegExp(p.replace(/[?.]/g, "\\$&"))).length).toBeGreaterThan(0);
  }
  expect(screen.getByText(/Release quality: test runs, flaky tests, go\/no-go/)).toBeTruthy();
  expect(needsWelcome("ana")).toBe(true);

  await user.click(screen.getByRole("button", { name: /Get started/ }));

  await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("c-general"));
  expect(agentDm).toHaveBeenCalledExactlyOnceWith("ag-scribe");
  expect(createEpoch).toHaveBeenCalledExactlyOnceWith("dm-scribe", [device]);
  expect(localStorage.getItem("sa.welcomed.ana")).not.toBeNull();
  expect(needsWelcome("ana")).toBe(false);
});

function Harness() {
  const [open, setOpen] = useState(false);
  usePaletteHotkey(setOpen);
  return (
    <>
      <CommandPalette open={open} onClose={() => setOpen(false)} />
      <Where />
    </>
  );
}

it("the command palette opens with Ctrl+K, closes on Escape and Enter jumps to the filtered chat", async () => {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Harness />
      </MemoryRouter>
    </ToastProvider>,
  );
  expect(screen.queryByRole("textbox")).toBeNull();

  await user.keyboard("{Control>}k{/Control}");
  expect(await screen.findByRole("textbox")).toBeTruthy();
  expect(screen.getByText("Roadmap")).toBeTruthy();
  expect(screen.getByText("general")).toBeTruthy();

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());

  await act(async () => {});
  await user.keyboard("{Control>}k{/Control}");
  await user.type(await screen.findByRole("textbox"), "roadm");
  expect(screen.queryByText("general")).toBeNull();
  expect(screen.getByText("Roadmap")).toBeTruthy();

  await user.keyboard("{Enter}");

  await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("c-road"));
  expect(screen.queryByRole("textbox")).toBeNull();
});
