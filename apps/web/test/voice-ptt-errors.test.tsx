import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PushToTalk } from "../src/voice/PushToTalk";

class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  private ls: Record<string, ((e: unknown) => void)[]> = {};
  addEventListener(t: string, fn: (e: unknown) => void) {
    this.ls[t] = [...(this.ls[t] ?? []), fn];
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    for (const f of this.ls.dataavailable ?? []) f({ data: new Blob([new Uint8Array([1])]) });
    for (const f of this.ls.stop ?? []) f({});
  }
}

let stops = 0;
let gum: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  stops = 0;
  gum = vi.fn(async () => ({ getTracks: () => [{ stop: () => stops++ }] }));
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: gum } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows the blocked message when permission is denied", async () => {
  gum.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
  render(<PushToTalk onSend={vi.fn()} />);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Hold to talk" }));
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(screen.getByText("Microphone access is blocked for this site.")).toBeTruthy();
});

it("shows 'Too short' for a quick tap and sends nothing", async () => {
  const onSend = vi.fn();
  render(<PushToTalk onSend={onSend} />);
  const btn = screen.getByRole("button", { name: "Hold to talk" });
  fireEvent.pointerDown(btn);
  await act(() => vi.advanceTimersByTimeAsync(200));
  fireEvent.pointerUp(btn);
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(screen.getByText("Too short")).toBeTruthy();
  expect(onSend).not.toHaveBeenCalled();
  expect(stops).toBe(1);
});

it("stops the mic when cancelled by Esc or by unmounting while the mic is still opening", async () => {
  const { unmount } = render(<PushToTalk onSend={vi.fn()} />);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Hold to talk" }));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  fireEvent.keyDown(document.body, { key: "Escape" });
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(stops).toBe(1);

  const onSend = vi.fn();
  const second = render(<PushToTalk onSend={onSend} />);
  fireEvent.pointerDown(second.getAllByRole("button", { name: "Hold to talk" })[1] as Element);
  second.unmount();
  await act(() => vi.advanceTimersByTimeAsync(61_000));
  expect(stops).toBe(2);
  expect(onSend).not.toHaveBeenCalled();
  unmount();
});
