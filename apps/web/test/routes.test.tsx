import type { Chat } from "@sa/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const { ana, general } = vi.hoisted(() => ({
  ana: { id: "ana", display_name: "Ana" },
  general: { id: "c1", title: "general", kind: "room", created_by: "ana", members: [] } as Chat,
}));

vi.mock("../src/api", async (orig) => ({
  ...(await orig<typeof import("../src/api")>()),
  getSession: () => ({ token: "tok", user: ana }),
}));
vi.mock("../src/state/session", () => {
  const value = {
    user: ana,
    phase: "ready",
    error: null,
    retry: () => {},
    engine: null,
    chats: [general],
    messages: {},
    unread: {},
    refreshChats: async () => [general],
    view: () => ({ threads: {}, reactions: {} }),
    openChat: () => {},
  };
  return {
    SessionProvider: ({ children }: { children: unknown }) => children,
    useSession: () => value,
    useActivity: () => ({}),
  };
});
vi.mock("../src/composer/Composer", () => ({
  Composer: (p: { replyTo?: string; initial?: { text: string } }) => (
    <div data-testid="composer" data-reply={p.replyTo ?? ""} data-initial={p.initial?.text ?? ""} />
  ),
}));
vi.mock("../src/channel/ThreadView", () => ({
  ThreadView: (p: { rootId: string }) => <div>thread-view {p.rootId}</div>,
}));
vi.mock("../src/channel/ChannelHeader", () => ({ ChannelHeader: () => <div>channel-header</div> }));
vi.mock("../src/channel/TryThisCard", () => ({ TryThisCard: () => null }));
vi.mock("../src/channel/MessageList", () => ({
  MessageList: () => <div>message-list</div>,
  DayDivider: () => null,
  SystemLine: () => null,
}));
vi.mock("../src/channel/LiveStatus", () => ({
  LiveStatus: () => null,
  WorkingBadge: () => null,
  LiveAnnouncer: () => null,
}));
vi.mock("../src/rail/RelayRail", () => ({
  RelayRail: () => <aside aria-label="What the relay sees" />,
}));
vi.mock("../src/rail/MembersRail", () => ({ MembersRail: () => <div>members-rail</div> }));
vi.mock("../src/rail/ActivityRail", () => ({ ActivityRail: () => <div>activity-rail</div> }));

import { App } from "../src/App";
import { markWelcomed } from "../src/onboarding/firstRun";

let keyN = 0;
/** Moves the browser to a URL the way a router push would, with an optional location.state. */
function go(path: string, state?: unknown) {
  keyN += 1;
  act(() => {
    window.history.pushState({ usr: state ?? null, key: `k${keyN}`, idx: keyN }, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

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
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { status: 200 })),
  );
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
});

it("sends a first-time user to /welcome and a returning user to the first channel", async () => {
  render(<App />);
  expect(await screen.findByText("Meet your team")).toBeTruthy();
  expect(window.location.pathname).toBe("/welcome");

  markWelcomed("ana");
  go("/");
  expect(await screen.findByText("message-list")).toBeTruthy();
  expect(window.location.pathname).toBe("/c/c1");
});

it("opens the thread panel from /c/:chatId/t/:rootId and prefills the composer once per location key", async () => {
  markWelcomed("ana");
  window.history.replaceState(
    { usr: { compose: { text: "Hello @Ops" } }, key: "start", idx: 0 },
    "",
    "/c/c1/t/r1",
  );
  render(<App />);
  expect(await screen.findByText("thread-view r1")).toBeTruthy();
  const composers = () => screen.getAllByTestId("composer");
  const thread = () => composers().find((c) => c.getAttribute("data-reply") === "r1");
  expect(thread()?.getAttribute("data-initial")).toBe("Hello @Ops");

  go("/c/c1/t/r1");
  await waitFor(() => expect(thread()?.getAttribute("data-initial")).toBe(""));

  go("/c/c1/t/r1", { compose: { text: "Second" } });
  await waitFor(() => expect(thread()?.getAttribute("data-initial")).toBe("Second"));
});

it("opens the palette on Cmd+K and handles its sa:palette-action events", async () => {
  markWelcomed("ana");
  window.history.replaceState(null, "", "/c/c1");
  render(<App />);
  await screen.findByText("message-list");

  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
  });
  expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  const fire = (detail: string) =>
    act(() => {
      window.dispatchEvent(new CustomEvent("sa:palette-action", { detail }));
    });
  fire("new-chat");
  expect(await screen.findByRole("dialog", { name: "New chat" })).toBeTruthy();

  expect(screen.queryByRole("complementary", { name: "What the relay sees" })).toBeNull();
  fire("toggle-relay");
  expect(await screen.findByRole("complementary", { name: "What the relay sees" })).toBeTruthy();
  fire("toggle-relay");
  await waitFor(() =>
    expect(screen.queryByRole("complementary", { name: "What the relay sees" })).toBeNull(),
  );
});
