import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/state/session", () => ({
  useSession: () => ({ user: { id: "ana", display_name: "Ana" } }),
}));
vi.mock("../src/approvals/PendingPill", () => ({ PendingPill: () => null }));

import { resetAuthProvidersCache } from "../src/auth/oidc";
import { TopBar } from "../src/shell/TopBar";

const TRUST = "Sign-in uses Google · chats and AI stay on this Mac";
const USUAL = "Every model runs on this Mac · the relay sees ciphertext only";

function stub(listed: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/auth/providers" && listed
        ? new Response(JSON.stringify({ pin: true, oidc: [{ id: "google", label: "Google" }] }))
        : new Response("{}", { status: 404 }),
    ),
  );
}
const bar = () => (
  <TopBar onToggleRelay={() => {}} onOpenPalette={() => {}} onSwitchUser={() => {}} />
);

beforeEach(resetAuthProvidersCache);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("the top bar trust strip says the D-14 line with Google on, the usual strip without", async () => {
  stub(true);
  render(bar());
  expect(await screen.findByText(TRUST)).toBeTruthy();
  expect(screen.queryByText(USUAL)).toBeNull();
  cleanup();
  resetAuthProvidersCache();
  stub(false);
  render(bar());
  expect(await screen.findByText(USUAL)).toBeTruthy();
  expect(screen.queryByText(TRUST)).toBeNull();
});
