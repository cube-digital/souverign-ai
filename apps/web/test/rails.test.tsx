import type { ChatMessage } from "@sa/client";
import type { Agent, Chat, ChatMember } from "@sa/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const dev = (id: string) => [{ device_id: id, public_key: "k" }];
const JOINED_AT = 1_700_000_000_000;
const member = (m: Partial<ChatMember> & Pick<ChatMember, "member_id" | "display_name">) =>
  ({
    member_type: "user",
    role: "member",
    devices: dev(`dev-${m.member_id}`),
    joined_at: JOINED_AT,
    ...m,
  }) as ChatMember;

const group: Chat = {
  id: "chat-0001",
  title: "Project",
  kind: "group",
  created_by: "ana",
  members: [
    member({ member_id: "ana", display_name: "Ana", role: "owner" }),
    member({ member_id: "bob", display_name: "Bob" }),
    member({ member_id: "carol", display_name: "Carol", seed: true }),
    member({
      member_id: "ag-dev",
      display_name: "Dev",
      member_type: "agent",
      agent_scope: "workspace",
      status: "running",
    }),
    member({
      member_id: "ag-nora",
      display_name: "Nora",
      member_type: "agent",
      agent_scope: "personal",
      owner_display_name: "Ana",
      status: "running",
    }),
  ],
};

const agent = (id: string, name: string, scope: Agent["scope"], owner: string | null): Agent => ({
  id,
  name,
  template: "general",
  soul: "",
  owner_user_id: owner,
  device_id: `dev-${id}`,
  status: "running",
  scope,
  roster_id: null,
});

const replies: ChatMessage[] = Array.from({ length: 12 }, (_, i) => ({
  id: `m${i + 1}`,
  chatId: group.id,
  seq: i + 1,
  ts: JOINED_AT + i * 1000,
  senderDevice: "dev-ag-dev",
  epoch: 1,
  status: "ok" as const,
  body: {
    type: "text" as const,
    text: `reply ${i + 1}`,
    meta: { tools: ["search_docs"], ms: 2300 },
  },
}));

const h = vi.hoisted(() => ({
  addAgentWithKey: vi.fn(async () => ({})),
  addPersonWithKey: vi.fn(async () => ({})),
  removeWithKey: vi.fn(async () => ({})),
}));

vi.mock("../src/api", () => ({
  directory: vi.fn(async () => [{ id: "dave", display_name: "Dave", devices: dev("dev-dave") }]),
  agents: vi.fn(async () => [
    agent("ag-dev", "Dev", "workspace", null),
    agent("ag-sage", "Sage", "workspace", null),
    agent("ag-pia", "Pia", "personal", "ana"),
    agent("ag-nora", "Nora", "personal", "ana"),
  ]),
}));
vi.mock("../src/state/membership", () => h);
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    user: { id: "bob", display_name: "Bob" },
    chats: [group],
    engine: {},
    refreshChats: async () => [],
    ticket: async () => "t",
    deviceId: "dev-bob",
    messages: { [group.id]: replies },
  }),
  useActivity: () => ({
    [group.id]: {
      "dev-ag-dev": { body: { type: "activity", phase: "tool", tool: "grep_logs" }, ts: 1 },
    },
  }),
}));

import { timeOf } from "../src/lib/format";
import { ActivityRail } from "../src/rail/ActivityRail";
import { MembersRail } from "../src/rail/MembersRail";
import { RelayRail } from "../src/rail/RelayRail";
import { RailProvider } from "../src/shell/rail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("members rail: labels people and agents, and lets a non-owner add only workspace agents", async () => {
  render(
    <RailProvider>
      <MembersRail chatId={group.id} />
    </RailProvider>,
  );
  // seed colleague label, agent labels and the read-from time
  expect(await screen.findByText("demo colleague · hosted on this Mac")).toBeTruthy();
  expect(screen.getByText("Workspace agent")).toBeTruthy();
  expect(screen.getByText("Ana's agent")).toBeTruthy();
  expect(screen.getAllByText(`can read from ${timeOf(JOINED_AT)}`, { exact: false }).length).toBe(
    2,
  );

  // add rules for a non-owner in a group
  expect(screen.getByRole("button", { name: "Add agent Sage" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add agent Pia" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add Dave" })).toBeNull();
  // remove rules: workspace agents by any member, personal agents and people not
  expect(screen.getByRole("button", { name: "Remove Dev" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove Nora" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove Carol" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Add agent Sage" }));
  await waitFor(() => expect(h.addAgentWithKey).toHaveBeenCalledTimes(1));
  const arg = (h.addAgentWithKey.mock.calls[0] as unknown[])[0];
  expect(arg).toMatchObject({ chat: { id: group.id }, agent: { id: "ag-sage" } });
  expect(h.addPersonWithKey).not.toHaveBeenCalled();
});

it("activity rail shows live status and the last 10 replies; relay rail shows metadata only", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          seq: 5,
          ts: JOINED_AT,
          kind: "msg",
          chat_id: group.id,
          sender_device: "dev-ag-dev",
          to_device: null,
          size: 1536,
          ciphertext_prefix: "QUJDREVG",
        },
      ],
    })),
  );
  render(
    <RailProvider>
      <ActivityRail chatId={group.id} />
      <RelayRail chatId={group.id} />
    </RailProvider>,
  );
  expect(screen.getByText(/grep_logs/)).toBeTruthy();
  expect(screen.getAllByText(/^reply \d+$/).length).toBe(10);
  expect(screen.getByText("reply 12")).toBeTruthy();
  expect(screen.queryByText("reply 2")).toBeNull();
  expect(screen.getAllByText(/search_docs/).length).toBe(10);

  const relay = screen.getByRole("complementary", { name: "What the relay sees" });
  const rows = await within(relay).findAllByTestId("relay-row");
  expect(rows.length).toBe(1);
  expect(rows[0]?.textContent).toContain("1.5 KB");
  expect(relay.textContent).not.toContain("reply");
});
