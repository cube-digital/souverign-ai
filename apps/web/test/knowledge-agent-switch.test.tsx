import type { Agent, KnowledgeItem } from "@sa/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

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

const mk = (id: string, name: string): Agent => ({
  id,
  name,
  template: "general",
  soul: "",
  owner_user_id: "ana",
  device_id: `dev-${id}`,
  status: "running",
  scope: "personal",
  roster_id: null,
  share_private_in_chats: "always",
});
const doc: KnowledgeItem = {
  id: "k1",
  agent_id: "a1",
  kind: "document",
  title: "Only for Nora.pdf",
  mime: "application/pdf",
  size: 1,
  parts: 1,
  truncated: false,
  tags: [],
  origin_chat_id: null,
  origin_chat_title: null,
  taught_by_user_id: "ana",
  taught_by_name: "Ana",
  created_at: 0,
  preview: "",
};
afterEach(cleanup);

it("switching agent drops the previous agent's items and loads the new agent's", async () => {
  api.knowledge.mockImplementation(async (id: string) => (id === "a1" ? [doc] : []));
  api.lessons.mockResolvedValue([]);
  const { rerender } = render(<KnowledgeTab agent={mk("a1", "Nora")} onCloseItem={() => {}} />);
  expect(await screen.findByText("Only for Nora.pdf")).toBeTruthy();
  rerender(<KnowledgeTab agent={mk("a2", "Otto")} onCloseItem={() => {}} />);
  expect(await screen.findByText("Nothing taught yet. Teach a document or a lesson.")).toBeTruthy();
  expect(screen.queryByText("Only for Nora.pdf")).toBeNull();
});
