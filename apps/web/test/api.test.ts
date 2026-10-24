import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiFailure, chats } from "../src/api";

beforeEach(() => {
  sessionStorage.clear();
  history.replaceState(null, "", "/?slot=2");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

it("a 401 clears the session of the current slot only", async () => {
  sessionStorage.setItem("sa.session.2", "{}");
  sessionStorage.setItem("sa.session.3", "{}");
  sessionStorage.setItem("sa.session", "{}");
  const err = await chats().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiFailure);
  expect(sessionStorage.getItem("sa.session.2")).toBeNull();
  expect(sessionStorage.getItem("sa.session.3")).not.toBeNull();
  expect(sessionStorage.getItem("sa.session")).not.toBeNull();
});
