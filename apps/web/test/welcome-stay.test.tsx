import type { Chat } from "@sa/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ release: () => {} }));
const dm = { id: "dm-scribe", title: "Scribe", kind: "dm", created_by: "ana", members: [] };
vi.mock("../src/api", async (orig) => ({
  ...(await orig<typeof import("../src/api")>()),
  agents: vi.fn(async () => [{ id: "ag-scribe", name: "Scribe", roster_id: "scribe" }]),
  agentDm: vi.fn(
    () =>
      new Promise((r) => {
        h.release = () => r(dm);
      }),
  ),
}));
const general = { id: "c-general", title: "general", kind: "room", seed_key: "general" } as Chat;
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    user: { id: "ana", display_name: "Ana" },
    engine: { latestEpoch: async () => 1, createEpoch: async () => 1 },
    chats: [general],
    refreshChats: async () => [general],
  }),
}));

import { ToastProvider } from "../src/ds";
import { WelcomePage } from "../src/onboarding/WelcomePage";

function Elsewhere() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/c/dm-scribe")}>
      sidebar Scribe
    </button>
  );
}
function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

afterEach(cleanup);

it("a chat opened while the first run finishes is not replaced by #general", async () => {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/welcome"]}>
        <Routes>
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/c/:id" element={<div />} />
        </Routes>
        <Elsewhere />
        <Where />
      </MemoryRouter>
    </ToastProvider>,
  );
  await user.click(screen.getByRole("button", { name: /Get started/ }));
  await user.click(screen.getByRole("button", { name: "sidebar Scribe" }));
  await act(async () => h.release());
  await act(async () => {});
  expect(screen.getByTestId("where").textContent).toBe("/c/dm-scribe");
});
