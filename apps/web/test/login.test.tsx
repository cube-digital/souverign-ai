import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";

const ana = { id: "ana", display_name: "Ana" };

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/users") return reply(200, [ana]);
      if (url === "/api/login") {
        const { pin } = JSON.parse(String(init?.body));
        return pin === "111111"
          ? reply(200, { token: "tok", user: ana })
          : reply(401, { error: "wrong_pin" });
      }
      return reply(404, { error: "not_found" });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows Wrong PIN for a bad PIN, then signs in with the right one", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /Ana/ }));
  await user.type(screen.getByLabelText("PIN"), "000000");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Wrong PIN")).toBeTruthy();
  expect(sessionStorage.getItem("sa.session")).toBeNull();

  await user.clear(screen.getByLabelText("PIN"));
  await user.type(screen.getByLabelText("PIN"), "111111");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(sessionStorage.getItem("sa.session")).not.toBeNull());
  expect(JSON.parse(sessionStorage.getItem("sa.session") ?? "")).toEqual({
    token: "tok",
    user: ana,
  });
  expect(await screen.findByText("Your chats appear here")).toBeTruthy();
});
