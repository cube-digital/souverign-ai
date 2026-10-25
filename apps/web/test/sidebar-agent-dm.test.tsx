import type { Agent, Chat } from "@sa/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  template: "general",
  soul: "",
  owner_user_id: null,
  device_id: `dev-${id}`,
  status: "running",
  scope: "workspace",
  roster_id: null,
});
vi.mock("../src/api", () => ({
  agents: vi.fn(async () => [agent("ag-scribe", "Scribe"), agent("ag-ops", "Ops")]),
}));
const dm = {
  id: "dm-1",
  title: "Scribe",
  kind: "dm",
  created_by: "ana",
  members: [
    { member_type: "user", member_id: "ana", role: "owner", devices: [] },
    { member_type: "agent", member_id: "ag-scribe", role: "member", devices: [] },
  ],
} as unknown as Chat;
vi.mock("../src/state/session", () => ({
  useSession: () => ({ chats: [dm], unread: {}, mentions: {} }),
}));

import { Sidebar } from "../src/shell/Sidebar";

afterEach(cleanup);

it("lists an agent with its own DM in both places: its DM under Direct messages and the agent under Agents", async () => {
  const opened: string[] = [];
  render(
    <Sidebar
      activeChatId={null}
      onOpenChat={(id) => opened.push(`chat:${id}`)}
      onOpenAgent={(a) => opened.push(`agent:${a.id}`)}
      onNewChat={() => {}}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Chats" });
  expect(await within(nav).findByRole("button", { name: "Agent Ops, running" })).toBeTruthy();
  const agentRow = within(nav).getByRole("button", { name: "Agent Scribe, running" });
  // the DM row keeps its name, so one row answers to "Scribe"
  const dmRow = within(nav).getByRole("button", { name: /^Scribe\b/ });
  dmRow.click();
  agentRow.click();
  expect(opened).toEqual(["chat:dm-1", "agent:ag-scribe"]);
});
