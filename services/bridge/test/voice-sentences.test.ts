import { describe, expect, it } from "vitest";
import { SentenceSplitter, speakable } from "../src/voice/sentences.js";

describe("streamed reply text is spoken sentence by sentence in order", () => {
  it("emits a sentence only once its boundary has arrived, flushes the rest, and strips markdown", () => {
    const s = new SentenceSplitter();
    expect(s.push("Hello there, Ana. The clu")).toEqual(["Hello there, Ana."]);
    expect(s.push("ster is fine! Ok")).toEqual(["The cluster is fine!"]);
    expect(s.flush()).toEqual(["Ok"]);
    expect(s.flush()).toEqual([]);

    expect(
      speakable("Run this:\n```ts\nrm -rf /\n```\nsee [the docs](https://x.example/a) now"),
    ).toBe("Run this: see the docs now");
  });
});
