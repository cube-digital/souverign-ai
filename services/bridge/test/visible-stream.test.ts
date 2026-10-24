import { describe, expect, it } from "vitest";
import { visibleStream } from "../src/agents/runtime.js";

describe("visibleStream", () => {
  it("hides closed, unclosed and partially opened think text", () => {
    expect(visibleStream("a<think>x</think>b")).toBe("ab");
    expect(visibleStream("a<think>still thinking")).toBe("a");
    expect(visibleStream("a<thi")).toBe("a");
    expect(visibleStream("1 < 2")).toBe("1 < 2");
  });
});
