// Acceptance test for T10 recorder. Assumed signature (apps/web/src/voice/recorder.ts):
//   startRecording(opts: { maxMs?: number; onAutoStop?: (rec: Rec | null) => void }):
//     Promise<{ stop(): Promise<Rec | null>; cancel(): void }> | { ... }
//   type Rec = { bytes: Uint8Array | ArrayBuffer; mime: string; durationMs: number }
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startRecording } from "../src/voice/recorder";

const stopped: string[] = [];

class FakeRecorder {
  static isTypeSupported = (m: string) => m === "audio/webm;codecs=opus" || m === "audio/mp4";
  state = "inactive";
  mimeType: string;
  private ls: Record<string, ((e: unknown) => void)[]> = {};
  ondataavailable: ((e: unknown) => void) | null = null;
  onstop: ((e?: unknown) => void) | null = null;
  constructor(
    public stream: unknown,
    opts?: { mimeType?: string },
  ) {
    this.mimeType = opts?.mimeType ?? "audio/webm;codecs=opus";
  }
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
  stopped.length = 0;
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  const track = (id: string) => ({ stop: () => stopped.push(id) });
  let n = 0;
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [track(`t${++n}`)] })),
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("discards a 300 ms hold as null and stops the mic, and auto-stops a long hold at 60 s", async () => {
  const short = await startRecording({ onAutoStop: vi.fn() });
  await vi.advanceTimersByTimeAsync(300);
  expect(await short.stop()).toBeNull();
  expect(stopped).toEqual(["t1"]);

  const onAutoStop = vi.fn();
  await startRecording({ maxMs: 60_000, onAutoStop });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(onAutoStop).toHaveBeenCalledTimes(1);
  const rec = onAutoStop.mock.calls[0]?.[0];
  expect(rec.mime).toBe("audio/webm;codecs=opus");
  expect(rec.durationMs).toBeLessThanOrEqual(60_000);
  expect(rec.durationMs).toBeGreaterThanOrEqual(59_000);
  expect(stopped).toEqual(["t1", "t2"]);
});
