import { afterEach, expect, it, vi } from "vitest";
import { Speaker } from "../src/voice/voice-turn.js";
import { FakeAudio, makeWav } from "./voice-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("a failed TTS sentence logs the error name, never the message an engine could fill with request text", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const audio = new FakeAudio({
    speak: async (t) => {
      if (t.startsWith("Second")) throw new TypeError("engine said: Second private sentence");
      return makeWav(100);
    },
  });
  const s = new Speaker(audio, "en", () => {});
  s.push("First sentence here. Second private sentence. ");
  await s.finish();
  const logged = JSON.stringify(warn.mock.calls);
  expect(logged).toContain("TypeError");
  expect(logged).not.toContain("private");
});
