import type { Agent, Chat, ChatMember, Routine } from "@sa/protocol";
import { ROSTER } from "@sa/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({
  id,
  name,
  template: "general",
  soul: "",
  owner_user_id: null,
  device_id: `dev-${id}`,
  status: "running",
  scope: "workspace",
  roster_id: null,
  ...over,
});
const rosterAgents: Agent[] = ROSTER.map((r) =>
  agent(`ag-${r.id}`, r.name, { template: r.template, roster_id: r.id }),
);
const mine = agent("ag-mine", "Nora", { scope: "personal", owner_user_id: "ana" });

const member = (type: "user" | "agent", id: string, joined_at?: number): ChatMember => ({
  member_type: type,
  member_id: id,
  display_name: id,
  role: "member",
  devices: [],
  ...(joined_at ? { joined_at } : {}),
});
const chat = (id: string, title: string, members: ChatMember[]): Chat => ({
  id,
  title,
  kind: "group",
  created_by: "ana",
  members,
});
const JOINED = new Date(2026, 9, 20, 14, 30).getTime();
const chatsList: Chat[] = [
  chat("c-rel", "Release room", [member("user", "ana"), member("agent", "ag-qa", JOINED)]),
  chat("c-ops", "Ops room", [member("user", "ana"), member("agent", "ag-qa", JOINED)]),
  chat("c-free", "Free room", [member("user", "ana")]),
  chat("c-solo", "Agent only", [member("agent", "ag-qa", JOINED)]),
];

const routine = (over: Partial<Routine>): Routine => ({
  id: "r1",
  kind: "routine",
  user_id: "ana",
  agent_id: "ag-qa",
  chat_id: "c-rel",
  days: [1, 2, 3, 4, 5],
  time: "09:00",
  prompt: "Post release status",
  paused: false,
  last_run_at: null,
  ...over,
});
const watch = routine({
  id: "w1",
  kind: "alert_watch",
  user_id: null,
  agent_id: "ag-qa",
  chat_id: "c-ops",
  prompt: "Watch for alerts",
});

const api = vi.hoisted(() => ({
  agents: vi.fn(),
  agentDm: vi.fn(),
  createAgent: vi.fn(),
  routines: vi.fn(),
  createRoutine: vi.fn(),
  updateRoutine: vi.fn(),
  deleteRoutine: vi.fn(),
  getPrefs: vi.fn(),
  setPrefs: vi.fn(),
}));
vi.mock("../src/api", () => api);

const addAgentWithKey = vi.hoisted(() => vi.fn());
vi.mock("../src/state/membership", () => ({ addAgentWithKey }));

vi.mock("../src/state/session", () => ({
  useSession: () => ({
    user: { id: "ana", display_name: "Ana" },
    chats: chatsList,
    messages: {},
    engine: {},
    refreshChats: async () => chatsList,
    unread: {},
  }),
  useActivity: () => ({}),
}));

import { AgentProfilePage } from "../src/agents/AgentProfilePage";
import { AgentsDirectoryPage } from "../src/agents/AgentsDirectoryPage";

const QA = ROSTER.find((r) => r.id === "qa");

function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/agents" element={<AgentsDirectoryPage />} />
        <Route path="/agents/:agentId" element={<AgentProfilePage />} />
        <Route path="/c/:chatId" element={<div>conversation opened</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.agents.mockResolvedValue([...rosterAgents, mine]);
  api.routines.mockResolvedValue([routine({}), watch]);
  api.getPrefs.mockResolvedValue({ pause_all: false, time_zone: "Europe/Zurich" });
  api.setPrefs.mockImplementation(async (p) => p);
  api.updateRoutine.mockResolvedValue(routine({ paused: true }));
  api.createRoutine.mockResolvedValue(routine({ id: "r2" }));
  api.deleteRoutine.mockResolvedValue({ ok: true });
  api.agentDm.mockResolvedValue(chat("c-dm", "QA", []));
  addAgentWithKey.mockResolvedValue(chatsList[2]);
});
afterEach(cleanup);

it("directory: six workspace cards with examples, personal cards, Message and Add to chat, template choice", async () => {
  const user = userEvent.setup();
  at("/agents");

  const qaCard = await screen.findByRole("region", { name: "QA" });
  for (const r of ROSTER) {
    expect(await screen.findByRole("region", { name: r.name })).toBeTruthy();
  }
  for (const example of QA?.examples ?? []) {
    expect(within(qaCard).getByText(example)).toBeTruthy();
  }
  expect(screen.getByRole("region", { name: "Nora" })).toBeTruthy();

  // Add to chat lists only the chats the agent is not in
  await user.click(within(qaCard).getByRole("button", { name: "Add to chat" }));
  expect(screen.queryByRole("menuitem", { name: /Release room/ })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /Ops room/ })).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: /Free room/ }));
  await waitFor(() => expect(addAgentWithKey).toHaveBeenCalledTimes(1));
  expect(addAgentWithKey.mock.calls[0]?.[0]).toMatchObject({
    agent: { id: "ag-qa" },
    chat: { id: "c-free" },
  });

  // Message opens the DM
  await user.click(within(qaCard).getByRole("button", { name: "Message" }));
  expect(api.agentDm).toHaveBeenCalledWith("ag-qa");
  expect(await screen.findByText("conversation opened")).toBeTruthy();
});

it("directory: creating a personal agent offers only the General and DevOps templates", async () => {
  const user = userEvent.setup();
  at("/agents");
  api.createAgent.mockResolvedValue(agent("ag-new", "Rex", { scope: "personal" }));

  await user.click(await screen.findByRole("button", { name: "+ New agent" }));
  const select = screen.getByLabelText("Template") as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["General", "DevOps"]);

  await user.type(screen.getByLabelText("Name"), "Rex");
  await user.selectOptions(select, "devops");
  await user.type(screen.getByLabelText("Personality"), "Terse.");
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await waitFor(() => expect(api.createAgent).toHaveBeenCalledWith("Rex", "devops", "Terse."));
});

it("profile overview: role, tools, examples, status, autonomy badge and when it can read each chat", async () => {
  const user = userEvent.setup();
  at("/agents/ag-qa");

  expect(await screen.findByText(QA?.role ?? "")).toBeTruthy();
  expect(screen.getByText("reads and drafts · no writes")).toBeTruthy();
  for (const tool of QA?.tools ?? []) expect(screen.getByText(tool)).toBeTruthy();
  expect(screen.getByText("running")).toBeTruthy();
  // one "can read from" line per chat the agent is in (two), none for the others
  expect(screen.getAllByText(/can read from/)).toHaveLength(2);
  expect(screen.getByText(/Release room/)).toBeTruthy();
  expect(screen.getByText(/Ops room/)).toBeTruthy();
  expect(screen.queryByText(/Free room/)).toBeNull();

  // an example opens the DM
  await user.click(screen.getByText(QA?.examples[0] ?? ""));
  await waitFor(() => expect(api.agentDm).toHaveBeenCalledWith("ag-qa"));
  expect(await screen.findByText("conversation opened")).toBeTruthy();
});

it("routines tab: lists routines in the Mac's time zone, pauses and deletes; the alert watch is workspace-owned", async () => {
  const user = userEvent.setup();
  at("/agents/ag-qa?tab=routines");

  expect(await screen.findByText("Times are in Europe/Zurich, this Mac's time zone")).toBeTruthy();
  expect(api.routines).toHaveBeenCalledWith("ag-qa");
  const mineRow = screen.getByText("Post release status").closest("li") as HTMLElement;
  const watchRow = screen.getByText("Watch for alerts").closest("li") as HTMLElement;
  expect(within(watchRow).getByText("Workspace · anyone can pause")).toBeTruthy();
  expect(within(watchRow).queryByRole("button", { name: /delete/i })).toBeNull();

  await user.click(within(mineRow).getByRole("switch", { name: /pause/i }));
  expect(api.updateRoutine).toHaveBeenCalledWith("r1", true);

  await user.click(within(mineRow).getByRole("button", { name: /delete/i }));
  await waitFor(() => expect(api.deleteRoutine).toHaveBeenCalledWith("r1"));
});

it("routines tab: the create form posts Mon-Fri 09:00 by default with the chosen chat and prompt; Pause all saves the pref", async () => {
  const user = userEvent.setup();
  at("/agents/ag-qa?tab=routines");

  await screen.findByText("Times are in Europe/Zurich, this Mac's time zone");
  // only chats where both the user and the agent are members
  const chatSelect = screen.getByLabelText(/^chat/i) as HTMLSelectElement;
  expect(Array.from(chatSelect.options).map((o) => o.textContent)).toEqual([
    "Release room",
    "Ops room",
  ]);
  expect((screen.getByLabelText(/^time/i) as HTMLInputElement).value).toBe("09:00");

  await user.selectOptions(chatSelect, "c-ops");
  await user.type(screen.getByLabelText(/^prompt/i), "Summarize overnight alerts");
  await user.click(screen.getByRole("button", { name: /(create|add|save) routine/i }));
  await waitFor(() =>
    expect(api.createRoutine).toHaveBeenCalledWith({
      agent_id: "ag-qa",
      chat_id: "c-ops",
      days: [1, 2, 3, 4, 5],
      time: "09:00",
      prompt: "Summarize overnight alerts",
    }),
  );

  await user.click(screen.getByRole("switch", { name: /pause all my proactive posts/i }));
  await waitFor(() => expect(api.setPrefs).toHaveBeenCalledTimes(1));
  expect(api.setPrefs.mock.calls[0]?.[0]).toMatchObject({ pause_all: true });
});
