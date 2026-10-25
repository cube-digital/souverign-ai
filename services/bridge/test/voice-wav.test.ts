import { describe, expect, it } from "vitest";
import { concatWav, parseWav, wavDurationMs } from "../src/voice/wav.js";
import { makeWav } from "./voice-fixture.js";

describe("per-sentence WAVs join into one voice reply", () => {
  it("joins two 100 ms clips into 200 ms with one canonical header and refuses mixed formats", () => {
    const joined = concatWav([makeWav(100), makeWav(100)]);
    expect(wavDurationMs(joined)).toBe(200);
    expect(joined.length).toBe(44 + 2 * 4800);
    const p = parseWav(joined);
    expect([p.sampleRate, p.channels, p.bitsPerSample, p.data.length]).toEqual([
      24000, 1, 16, 9600,
    ]);

    // chunks are walked, not assumed at fixed offsets
    expect(parseWav(makeWav(100, 24000, true)).data.length).toBe(4800);

    expect(() => concatWav([makeWav(100), makeWav(100, 22050)])).toThrow("wav_format_mismatch");
    expect(() => parseWav(new Uint8Array(64))).toThrow("bad_wav");
  });
});
