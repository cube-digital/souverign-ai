import { describe, expect, it } from "vitest";
import { MAX_SPOKEN_CHARS, Speaker, type SpokenChunk } from "../src/voice/voice-turn.js";
import { wavDurationMs } from "../src/voice/wav.js";
import { FakeAudio, makeWav } from "./voice-fixture.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sentence = (n: number) => `${"x".repeat(n - 1)}.`;

describe("spoken audio is ordered, capped at 600 characters, and survives a failed sentence", () => {
  it("keeps order when TTS resolves out of order, stops at the cap, skips a failure, and abort yields no audio", async () => {
    expect(MAX_SPOKEN_CHARS).toBe(600);

    // 1. first sentence is slowest, yet chunks arrive 0, 1, 2 in text order
    const slowFirst = new FakeAudio({
      speak: async (t) => {
        await sleep(t.startsWith("First") ? 60 : 5);
        return makeWav(100);
      },
    });
    const chunks: SpokenChunk[] = [];
    const a = new Speaker(
      slowFirst,
      "en",
      (c) => chunks.push(c),
      () => 5000,
    );
    a.push("First sentence here. Second sentence here. Third sentence here. ");
    const ra = await a.finish();
    expect(chunks.map((c) => [c.seq, c.text])).toEqual([
      [0, "First sentence here."],
      [1, "Second sentence here."],
      [2, "Third sentence here."],
    ]);
    expect(ra.firstAudioAt).toBe(5000);
    expect(ra.durationMs).toBe(300);
    expect(wavDurationMs(ra.wav as Uint8Array)).toBe(300);

    // 2. two 300-char sentences fill the cap; the third is never synthesised
    const capAudio = new FakeAudio();
    const b = new Speaker(capAudio, "en", () => {});
    b.push(`${sentence(300)} ${sentence(300)} ${sentence(300)} `);
    const rb = await b.finish();
    expect(capAudio.spoken.map((s) => s.text.length)).toEqual([300, 300]);
    expect(rb.durationMs).toBe(200);

    // 3. a failing sentence is skipped, the others are spoken
    const flaky = new FakeAudio({
      speak: async (t) => {
        if (t.startsWith("Second")) throw new Error("tts_failed_500");
        return makeWav(100);
      },
    });
    const got: string[] = [];
    const c = new Speaker(flaky, "en", (k) => got.push(k.text));
    c.push("First sentence here. Second sentence here. Third sentence here. ");
    const rc = await c.finish();
    expect(got).toEqual(["First sentence here.", "Third sentence here."]);
    expect(rc.durationMs).toBe(200);

    // 4. abort drops everything
    const d = new Speaker(new FakeAudio(), "en", () => {});
    d.push("First sentence here. Second sentence here. ");
    d.abort();
    const rd = await d.finish();
    expect(rd.wav).toBeNull();
    expect(rd.durationMs).toBe(0);

    // nothing speakable at all: no audio
    const e = new Speaker(new FakeAudio(), "en", () => {});
    e.push("```\ncode only\n```");
    expect((await e.finish()).wav).toBeNull();
  });
});
