// Acceptance test for T10 voice stream + latency. Assumed signatures (apps/web/src/voice/):
//   voiceStream.ts: class VoicePlayer { constructor(sourceId: string); push(chunk: { seq: number; wav_b64: string; text?: string }): void|Promise<void> }
//                   stopAll(): void
//   latency.ts:     markSent(sourceId: string, releasedAt: number): void; firstAudio(sourceId: string, now: number): number | null
// Fake AudioContext: decodeAudioData returns { id } from the WAV bytes; createBufferSource().start() records the id
// and fires onended / "ended" immediately, so both chained and pre-scheduled playback are supported.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { firstAudio, markSent } from "../src/voice/latency";
import { VoicePlayer } from "../src/voice/voiceStream";

const started: string[] = [];
let contexts = 0;

class FakeAudioContext {
  currentTime = 0;
  state = "running";
  destination = {};
  constructor() {
    contexts++;
  }
  async decodeAudioData(buf: ArrayBuffer) {
    return { id: String.fromCharCode(...new Uint8Array(buf)), duration: 1 };
  }
  createBufferSource() {
    const ls: (() => void)[] = [];
    const src = {
      buffer: null as { id: string } | null,
      onended: null as (() => void) | null,
      connect() {},
      disconnect() {},
      stop() {},
      addEventListener: (_: string, f: () => void) => ls.push(f),
      removeEventListener() {},
      start() {
        started.push(src.buffer?.id ?? "?");
        queueMicrotask(() => {
          src.onended?.();
          for (const f of ls) f();
        });
      },
    };
    return src;
  }
  async resume() {}
  async close() {}
}

const chunk = (seq: number) => ({ seq, text: `s${seq}`, wav_b64: btoa(`w${seq}`) });
const flush = () => vi.advanceTimersByTimeAsync(20);

beforeEach(() => {
  vi.useFakeTimers();
  started.length = 0;
  contexts = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("plays chunks 1, 0, 2 as 0, 1, 2 through one AudioContext, drops a late lower seq, and reports first audio once", async () => {
  const p = new VoicePlayer("src-1");
  p.push(chunk(1));
  await flush();
  expect(started).toEqual([]);
  p.push(chunk(0));
  await flush();
  expect(started).toEqual(["w0", "w1"]);
  p.push(chunk(2));
  await flush();
  p.push(chunk(1));
  await flush();
  expect(started).toEqual(["w0", "w1", "w2"]);
  expect(contexts).toBe(1);

  markSent("src-1", 1000);
  expect(firstAudio("src-1", 2830)).toBe(1830);
  expect(firstAudio("src-1", 3000)).toBeNull();
  markSent("src-2", 1000);
  expect(firstAudio("src-2", 1000 + 121_000)).toBeNull();
  expect(firstAudio("never-sent", 5000)).toBeNull();
});
