import { describe, expect, it } from "vitest";
import {
  addTurnHooks,
  clearTurnHooks,
  runBeforeReply,
  runStored,
} from "../src/agents/turn-hooks.js";

const ctx = {
  turnId: "t",
  agentId: "a",
  agentName: "A",
  chatId: "c",
  replyTo: null,
  triggerMessageId: null,
  requesterUserId: null,
  trigger: "mention" as const,
  prompt: "p",
  noTaught: false,
};

describe("turn hook failures", () => {
  it("reports failed for a throwing beforeReply but not for a plain hold", async () => {
    clearTurnHooks();
    addTurnHooks({ name: "hold", beforeReply: async () => ({ action: "hold", notice: "wait" }) });
    const hold = await runBeforeReply(ctx, { text: "x", meta: {} }, () => {});
    expect([hold.held, hold.failed]).toEqual([true, undefined]);
    clearTurnHooks();
    addTurnHooks({
      name: "boom",
      beforeReply: async () => {
        throw new Error("x");
      },
    });
    const bad = await runBeforeReply(ctx, { text: "x", meta: {} }, () => {});
    expect([bad.held, bad.failed]).toEqual([true, true]);
    clearTurnHooks();
  });

  it("a synchronously throwing onStored hook does not stop later hooks", async () => {
    clearTurnHooks();
    let seen = 0;
    addTurnHooks({
      name: "sync-boom",
      onStored: (() => {
        throw new Error("sync");
      }) as never,
    });
    addTurnHooks({
      name: "ok",
      onStored: async () => {
        seen++;
      },
    });
    runStored({} as never, () => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toBe(1);
    clearTurnHooks();
  });
});
