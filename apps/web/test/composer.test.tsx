import type { Agent, Chat } from "@sa/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  log: [] as string[],
  engine: { sendText: vi.fn(), sendFile: vi.fn(async () => {}) },
  addAgentWithKey: vi.fn(),
  agents: [] as unknown[],
}));

vi.mock("../src/state/session", () => ({
  useSession: () => ({
    user: { id: "ana", display_name: "Ana" },
    deviceId: "dev-ana",
    engine: h.engine,
    chats: [],
    refreshChats: async () => [],
  }),
  useActivity: () => ({}),
}));
vi.mock("../src/api", () => ({ agents: vi.fn(async () => h.agents) }));
vi.mock("../src/state/membership", () => ({ addAgentWithKey: h.addAgentWithKey }));

import { Composer } from "../src/composer/Composer";

const dev = (id: string) => ({ device_id: id, public_key: "k" });
const mkChat = (seed_key: string): Chat => ({
  id: "chat-room01",
  title: "general",
  kind: "room",
  created_by: "ana",
  seed_key,
  members: [
    {
      member_type: "user",
      member_id: "ana",
      display_name: "Ana",
      role: "owner",
      devices: [dev("dev-ana")],
    },
    {
      member_type: "user",
      member_id: "mira",
      display_name: "Mira",
      role: "member",
      devices: [dev("dev-mira")],
    },
    {
      member_type: "agent",
      member_id: "ag-ops",
      display_name: "Ops",
      role: "member",
      agent_scope: "workspace",
      status: "running",
      devices: [dev("dev-ops")],
    },
  ],
});
const agent = (id: string, name: string, roster: string): Agent => ({
  id,
  name,
  template: roster as Agent["template"],
  soul: "",
  owner_user_id: null,
  device_id: `dev-${roster}`,
  status: "running",
  scope: "workspace",
  roster_id: roster,
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  h.log = [];
  h.agents = [agent("ag-ops", "Ops", "ops"), agent("ag-sales", "Sales", "sales")];
  h.engine.sendText.mockImplementation(async () => {
    h.log.push("send");
  });
  h.addAgentWithKey.mockImplementation(async () => {
    h.log.push("add");
  });
});
afterEach(cleanup);

const box = (name = "Message # general") => screen.getByRole("textbox", { name });

it("Enter sends and Shift+Enter adds a line; an initial quote is sent as a quote", async () => {
  render(
    <Composer chat={mkChat("general")} initial={{ text: "@Ops ", quote: "The disk is full" }} />,
  );
  await userEvent.type(box(), "why{Shift>}{Enter}{/Shift}");
  expect(h.engine.sendText).not.toHaveBeenCalled();
  expect((box() as HTMLTextAreaElement).value).toBe("@Ops why\n");
  await userEvent.type(box(), "now{Enter}");
  expect(h.engine.sendText).toHaveBeenCalledTimes(1);
  const call = h.engine.sendText.mock.calls[0] as unknown as unknown[];
  expect(call[0]).toBe("chat-room01");
  expect(call[1]).toBe("> The disk is full\n@Ops why\nnow");
});

it("lists people and agents after @, labels workspace agents outside the chat, and inserts the pick", async () => {
  render(<Composer chat={mkChat("general")} />);
  await userEvent.type(box(), "@");
  expect(screen.getByText("Mira")).toBeTruthy();
  expect(screen.getByText("Ops")).toBeTruthy();
  expect(await screen.findByText("not in this chat")).toBeTruthy();
  expect(screen.getByText("Sales")).toBeTruthy();
  await userEvent.type(box(), "O{Enter}");
  expect((box() as HTMLTextAreaElement).value).toBe("@Ops ");
});

async function tagSales(chat: Chat) {
  render(<Composer chat={chat} />);
  await userEvent.type(box(), "@Sa");
  await screen.findByText("not in this chat");
  await userEvent.keyboard("{Enter}");
  await userEvent.type(box(), "brief me{Enter}");
}

it("offers to add a tagged agent that is not in the chat, with its tools and the Sales warning", async () => {
  await tagSales(mkChat("general"));
  expect(
    screen.getByText("Add Sales to this chat? It will see messages from now on."),
  ).toBeTruthy();
  expect(screen.getByText(/crm_accounts/)).toBeTruthy();
  expect(screen.getByText(/crm_deal/)).toBeTruthy();
  expect(screen.getByText(/crm_activities/)).toBeTruthy();
  expect(screen.getByText("Sales can read CRM accounts and deals.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send without" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(h.engine.sendText).not.toHaveBeenCalled();
});

it("Add and send adds the agent first and then sends; no Sales warning inside #sales", async () => {
  await tagSales(mkChat("sales"));
  expect(screen.queryByText("Sales can read CRM accounts and deals.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Add and send" }));
  await waitFor(() => expect(h.log).toEqual(["add", "send"]));
  expect(h.addAgentWithKey).toHaveBeenCalledWith(
    expect.objectContaining({ agent: expect.objectContaining({ id: "ag-sales" }) }),
  );
  const call = h.engine.sendText.mock.calls[0] as unknown as unknown[];
  expect(call[1]).toBe("@Sales brief me");
});

it("keeps drafts per chat and per thread across a remount", async () => {
  const chat = mkChat("general");
  const first = render(<Composer chat={chat} />);
  await userEvent.type(box(), "half written");
  first.unmount();

  const inThread = render(<Composer chat={chat} replyTo="root-0001" />);
  expect((box("Reply in thread") as HTMLTextAreaElement).value).toBe("");
  inThread.unmount();

  render(<Composer chat={chat} />);
  expect((box() as HTMLTextAreaElement).value).toBe("half written");
});
