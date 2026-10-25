// Acceptance test for T10 PushToTalk. Assumed (apps/web/src/voice/PushToTalk.tsx):
//   export function PushToTalk(props: { onSend(rec: { bytes; mime: string; durationMs: number }): void; disabled?: boolean })
// It uses navigator.mediaDevices.getUserMedia + MediaRecorder (stubbed here), pointer events on the button.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PushToTalk } from "../src/voice/PushToTalk";

class FakeRecorder {
  static isTypeSupported = (m: string) => m === "audio/webm;codecs=opus";
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  private ls: Record<string, ((e: unknown) => void)[]> = {};
  ondataavailable: ((e: unknown) => void) | null = null;
  onstop: ((e?: unknown) => void) | null = null;
  addEventListener(t: string, fn: (e: unknown) => void) {
    this.ls[t] = [...(this.ls[t] ?? []), fn];
  }
  removeEventListener() {}
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    const ev = { data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) };
    this.ondataavailable?.(ev);
    for (const f of this.ls.dataavailable ?? []) f(ev);
    this.onstop?.({});
    for (const f of this.ls.stop ?? []) f({});
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("sends once on release, and sends nothing when Esc cancels the hold", async () => {
  const onSend = vi.fn();
  render(<PushToTalk onSend={onSend} />);
  const btn = screen.getByRole("button", { name: "Hold to talk" });

  fireEvent.pointerDown(btn);
  await act(() => vi.advanceTimersByTimeAsync(7000));
  expect(screen.getByText("0:07")).toBeTruthy();
  expect(screen.getByText("Release to send · Esc to cancel")).toBeTruthy();
  fireEvent.pointerUp(btn);
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(onSend.mock.calls[0]?.[0].mime).toBe("audio/webm;codecs=opus");
  expect(onSend.mock.calls[0]?.[0].durationMs).toBeGreaterThanOrEqual(6900);
  expect(onSend.mock.calls[0]?.[0].durationMs).toBeLessThanOrEqual(7100);

  fireEvent.pointerDown(btn);
  await act(() => vi.advanceTimersByTimeAsync(2000));
  fireEvent.keyDown(document.body, { key: "Escape" });
  fireEvent.pointerUp(btn);
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Release to send · Esc to cancel")).toBeNull();
});
