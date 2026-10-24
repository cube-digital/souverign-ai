import type { Agent, Chat } from "@sa/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const agent: Agent = {
  id: "ag1",
  name: "Nora",
  template: "general",
  soul: "",
  owner_user_id: null,
  device_id: "dev-nora",
  status: "running",
  scope: "workspace",
  roster_id: null,
};
vi.mock("../src/api", () => ({ agents: vi.fn(async () => [agent]) }));

const chat = (id: string, title: string, kind: Chat["kind"]): Chat => ({
  id,
  title,
  kind,
  created_by: "ana",
  members: [],
});
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    user: { id: "ana", display_name: "Ana" },
    chats: [chat("c1", "Roadmap", "room"), chat("c2", "Bob", "dm")],
    unread: { c1: 3, c2: 0 },
    activity: {},
    messages: {},
  }),
}));

import { AppShell } from "../src/shell/AppShell";
import { Sidebar } from "../src/shell/Sidebar";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(cleanup);

it("lists channels, direct messages and agents, with the unread count on the channel", async () => {
  render(
    <Sidebar
      activeChatId={null}
      onOpenChat={() => {}}
      onOpenAgent={() => {}}
      onNewChat={() => {}}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Chats" });
  expect(within(nav).getByText("Channels")).toBeTruthy();
  expect(within(nav).getByText("Direct messages")).toBeTruthy();
  expect(await within(nav).findByText("Agents")).toBeTruthy();
  const room = within(nav).getByRole("button", { name: /Roadmap/ });
  expect(within(room).getByText("3")).toBeTruthy();
  const dm = within(nav).getByRole("button", { name: /Bob/ });
  expect(within(dm).queryByText("0")).toBeNull();
  expect(await within(nav).findByRole("button", { name: /Nora/ })).toBeTruthy();
});

it("shows the right rail only when a rail is given", () => {
  const props = { sidebar: <div>side</div>, main: <div>main</div>, onCloseRail: () => {} };
  const { rerender } = render(<AppShell {...props} rail={null} />);
  expect(screen.queryByText("rail body")).toBeNull();
  rerender(<AppShell {...props} rail={<div>rail body</div>} />);
  expect(screen.getByText("rail body")).toBeTruthy();
});
