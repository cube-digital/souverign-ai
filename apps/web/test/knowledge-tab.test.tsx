import type { Agent, KnowledgeItem, KnowledgeItemDetail, Lesson } from "@sa/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  knowledge: vi.fn(),
  knowledgeItem: vi.fn(),
  lessons: vi.fn(),
  teachDocument: vi.fn(),
  deleteKnowledge: vi.fn(),
  addLesson: vi.fn(),
  deleteLesson: vi.fn(),
  setSharing: vi.fn(),
}));
vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return { ...api, ApiFailure: actual.ApiFailure };
});

import { KnowledgeTab } from "../src/agents/KnowledgeTab";
import { ApiFailure } from "../src/api";

const agent: Agent = {
  id: "ag-nora",
  name: "Nora",
  template: "general",
  soul: "",
  owner_user_id: "ana",
  device_id: "dev-nora",
  status: "running",
  scope: "personal",
  roster_id: null,
  share_private_in_chats: "always",
};

const TAUGHT = new Date(2026, 9, 24, 12, 0).getTime();
const item = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: "k1",
  agent_id: "ag-nora",
  kind: "document",
  title: "Supplier contract.pdf",
  mime: "application/pdf",
  size: 1000,
  parts: 3,
  truncated: false,
  tags: [],
  origin_chat_id: null,
  origin_chat_title: null,
  taught_by_user_id: "ana",
  taught_by_name: "Ana",
  created_at: TAUGHT,
  preview: "Payment within 30 days",
  ...over,
});
const doc = item({});
const note = item({
  id: "k2",
  kind: "note",
  title: "Dock closes at five",
  mime: null,
  size: null,
  parts: 1,
  origin_chat_id: "c-ops",
  origin_chat_title: "ops",
  taught_by_user_id: null,
  taught_by_name: null,
});
const lesson: Lesson = {
  id: "l1",
  agent_id: "ag-nora",
  text: "Always quote prices in CHF",
  taught_by_user_id: "ana",
  taught_by_name: "Ana",
  created_at: TAUGHT,
};

function renderTab(itemId?: string, onCloseItem = vi.fn()) {
  return render(<KnowledgeTab agent={agent} itemId={itemId} onCloseItem={onCloseItem} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.knowledge.mockResolvedValue([doc, note]);
  api.lessons.mockResolvedValue([lesson]);
  api.deleteKnowledge.mockResolvedValue({ ok: true });
  api.deleteLesson.mockResolvedValue({ ok: true });
  api.addLesson.mockResolvedValue(lesson);
  api.setSharing.mockImplementation(async (_id, p) => ({ share_private_in_chats: p }));
});
afterEach(cleanup);

it("lists what the agent knows with who taught it, and deleting asks for confirmation first", async () => {
  const user = userEvent.setup();
  renderTab();

  expect(await screen.findByText("Supplier contract.pdf")).toBeTruthy();
  expect(screen.getByText("Taught by Ana · 24 Oct")).toBeTruthy();
  expect(screen.getByText("3 pages")).toBeTruthy();
  expect(screen.getByText("Noted in #ops")).toBeTruthy();
  expect(screen.getByText("Always quote prices in CHF")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Documents" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Lessons" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Notes" })).toBeTruthy();

  const row = screen.getByText("Supplier contract.pdf").closest("li") as HTMLElement;
  await user.click(within(row).getByRole("button", { name: "Delete" }));
  expect(api.deleteKnowledge).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText("Delete Supplier contract.pdf? Nora will forget it."),
  ).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));

  await waitFor(() => expect(api.deleteKnowledge).toHaveBeenCalledWith("ag-nora", "k1"));
});

it("uploading a document calls teachDocument with the File, shows progress, then explains a 415", async () => {
  const user = userEvent.setup();
  let reject: (e: unknown) => void = () => {};
  api.teachDocument.mockReturnValue(
    new Promise((_, rej) => {
      reject = rej;
    }),
  );
  renderTab();
  await screen.findByText("Supplier contract.pdf");

  const file = new File(["%PDF"], "scan.pdf", { type: "application/pdf" });
  await user.upload(screen.getByLabelText("Teach a document"), file);

  expect(api.teachDocument).toHaveBeenCalledWith("ag-nora", file);
  expect(await screen.findByText("Reading scan.pdf…")).toBeTruthy();

  reject(new ApiFailure(415, { error: "unsupported_type" }));
  expect(
    await screen.findByText("That file type is not supported (PDF, DOCX, XLSX, TXT, MD)."),
  ).toBeTruthy();
  expect(screen.queryByText("Reading scan.pdf…")).toBeNull();
});

it("Add lesson sends the typed text to addLesson", async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByText("Supplier contract.pdf");

  await user.type(screen.getByLabelText("Teach a lesson"), "Greet suppliers by first name");
  expect(screen.getByText("29/500")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Add lesson" }));

  await waitFor(() =>
    expect(api.addLesson).toHaveBeenCalledWith("ag-nora", "Greet suppliers by first name"),
  );
});

it("choosing Ask first saves the sharing policy", async () => {
  const user = userEvent.setup();
  renderTab();
  const group = await screen.findByRole("radiogroup", {
    name: "Use taught knowledge in shared chats",
  });
  expect((within(group).getByRole("radio", { name: /Always/ }) as HTMLInputElement).checked).toBe(
    true,
  );
  expect(
    within(group).getByText("Ask me before an answer that uses what I taught it is posted."),
  ).toBeTruthy();

  await user.click(within(group).getByRole("radio", { name: /Ask first/ }));

  await waitFor(() => expect(api.setSharing).toHaveBeenCalledWith("ag-nora", "ask"));
});

it("itemId opens the source viewer with each segment under its label, and Close notifies the parent", async () => {
  const user = userEvent.setup();
  const detail: KnowledgeItemDetail = {
    ...doc,
    segments: [
      { label: "p. 1", text: "Parties and term" },
      { label: "p. 3", text: "Payment within 30 days of invoice" },
    ],
  };
  api.knowledgeItem.mockResolvedValue(detail);
  const onCloseItem = vi.fn();
  renderTab("k1", onCloseItem);

  expect(await screen.findByText("Payment within 30 days of invoice")).toBeTruthy();
  expect(api.knowledgeItem).toHaveBeenCalledWith("ag-nora", "k1");
  expect(screen.getByRole("heading", { name: "p. 3" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "p. 1" })).toBeTruthy();
  expect(screen.getByText("Parties and term")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onCloseItem).toHaveBeenCalledTimes(1);
});
