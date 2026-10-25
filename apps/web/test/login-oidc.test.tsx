import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { resetAuthProvidersCache } from "../src/auth/oidc";
import { PresenterPage } from "../src/pages/PresenterPage";

const ana = { id: "ana", display_name: "Ana" };
const CODE = "abcdefghijklmnopqrstuvwxyz";
const TRUST = "Sign-in uses Google · chats and AI stay on this Mac";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

function stubBridge(providers: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/auth/providers") return reply(providers.status, providers.body);
    if (url === "/api/users") return reply(200, [ana]);
    if (url === "/api/auth/oidc/exchange") return reply(200, { token: "tok-g", user: ana });
    return reply(404, { error: "not_found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const google = { status: 200, body: { pin: true, oidc: [{ id: "google", label: "Google" }] } };
const none = { status: 404, body: { error: "not_found" } };

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
beforeEach(() => {
  sessionStorage.clear();
  resetAuthProvidersCache();
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows the Google link and the trust line on the login page when the bridge lists Google", async () => {
  stubBridge(google);
  render(<App />);
  const link = await screen.findByRole("link", { name: "Sign in with Google" });
  expect(link.getAttribute("href")).toBe("/api/auth/oidc/google/start");
  expect(screen.getByText(TRUST)).toBeTruthy();
});

it("is the plain PIN picker when providers fail: no Google link, no trust line", async () => {
  stubBridge(none);
  render(<App />);
  expect(await screen.findByRole("button", { name: /Ana/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Sign in with/ })).toBeNull();
  expect(screen.queryByText(TRUST)).toBeNull();
});

it("exchanges the fragment code once, stores the session, and scrubs it from the URL and logs", async () => {
  const logs = [
    vi.spyOn(console, "log"),
    vi.spyOn(console, "info"),
    vi.spyOn(console, "warn"),
    vi.spyOn(console, "error"),
  ];
  const fetchMock = stubBridge(google);
  history.replaceState(null, "", `/#sa_login=${CODE}`);
  render(<App />);
  await waitFor(() => expect(sessionStorage.getItem("sa.session")).not.toBeNull());
  expect(JSON.parse(sessionStorage.getItem("sa.session") ?? "")).toEqual({
    token: "tok-g",
    user: ana,
  });
  const exchanges = fetchMock.mock.calls.filter(([u]) => u === "/api/auth/oidc/exchange");
  expect(exchanges).toHaveLength(1);
  expect(JSON.parse(String(exchanges[0]?.[1]?.body))).toEqual({ code: CODE });
  expect(location.hash).toBe("");
  expect(location.pathname).toBe("/");
  expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toContain(CODE);
});

it("shows plain English for a returned error code", async () => {
  stubBridge(google);
  history.replaceState(null, "", "/#sa_login_error=not_allowed");
  render(<App />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "This account is not allowed here. Ask the admin to add your email.",
  );
  expect(location.hash).toBe("");
});

it("Presenter shows the Google sign-in on badge only when Google is listed", async () => {
  stubBridge(google);
  render(<PresenterPage />);
  const badge = await screen.findByRole("status");
  expect(badge.textContent).toBe("Google sign-in on");
  cleanup();
  resetAuthProvidersCache();
  stubBridge(none);
  render(<PresenterPage />);
  await screen.findByText("All AI runs on this Mac");
  expect(screen.queryByText("Google sign-in on")).toBeNull();
});
