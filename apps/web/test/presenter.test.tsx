import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PresenterPage } from "../src/pages/PresenterPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("renders the presenter header, its four user frames and the trust pill", () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { status: 200 })),
  );
  render(<PresenterPage />);
  expect(screen.getByText("Presenter view")).toBeTruthy();
  for (const n of [1, 2, 3, 4]) {
    const frame = screen.getByTitle(`User ${n}`);
    expect(frame.getAttribute("src")).toBe(`/?slot=${n}`);
  }
  expect(screen.getByText("All AI runs on this Mac")).toBeTruthy();
});
