import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SA_LLM_CONCURRENCY = "2";
});

import { EchoRuntime } from "../src/agents/echo.js";
import { TurnQueue } from "../src/agents/turn-queue.js";
import {
  activityOf,
  addPersonalAgent,
  createWorld,
  person,
  reactionLog,
  rekey,
  sent,
  startChat,
  textsFrom,
  type World,
} from "./teammates-fixture.js";

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe("turn queue", () => {
  it("runs a waiting human turn before an earlier proactive one, first come first served within a class", async () => {
    const q = new TurnQueue({ concurrency: 1 });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const job = (name: string, wait?: Promise<void>) => async () => {
      order.push(name);
      await wait;
    };

    const running = q.enqueue(job("running", gate), "human");
    await new Promise((r) => setTimeout(r, 20));
    const proactive = q.enqueue(job("alert", undefined), "proactive");
    const humanA = q.enqueue(job("mention-a", undefined), "human");
    const humanB = q.enqueue(job("mention-b", undefined), "human");
    release();
    await Promise.all([running, proactive, humanA, humanB]);

    expect(order).toEqual(["running", "mention-a", "mention-b", "alert"]);
  });

  it("reacts 👀 before any wait and tells a waiting turn how many are ahead, counting down", async () => {
    w = await createWorld(new EchoRuntime({ delayMs: 1200 }));
    const ana = await person(w, "ana");
    const chat = await startChat(w, ana, "Ops room");
    const agents = [
      await addPersonalAgent(w, ana, chat, "Alpha"),
      await addPersonalAgent(w, ana, chat, "Bravo"),
      await addPersonalAgent(w, ana, chat, "Carol"),
      await addPersonalAgent(w, ana, chat, "Delta"),
    ];
    await rekey(w, chat, ana, [ana], agents);

    await ana.engine.sendText(chat, "@Alpha @Bravo @Carol @Delta all hands");
    const trigger = await sent(ana, "@Alpha @Bravo @Carol @Delta all hands");
    await expect
      .poll(() => agents.map((a) => textsFrom(ana, a.device_id).length), { timeout: 20000 })
      .toEqual([1, 1, 1, 1]);

    // concurrency is 2, so exactly two of the four turns had to wait
    const waiting = agents.filter((a) =>
      activityOf(ana, a.device_id).some((x) => x.body.phase === "queued"),
    );
    expect(waiting).toHaveLength(2);
    const aheadOf = (a: { device_id: string }) =>
      activityOf(ana, a.device_id)
        .filter((x) => x.body.phase === "queued")
        .map((x) => x.body.ahead as number);
    const countsDown = (a: { device_id: string }) =>
      aheadOf(a).every((n, i, all) => i === 0 || n < (all[i - 1] as number));
    expect(waiting.map(countsDown)).toEqual([true, true]);
    expect(Math.max(...waiting.map((a) => aheadOf(a).length))).toBeGreaterThanOrEqual(2);

    const eyesBeforeWait = (a: { device_id: string }) => {
      const eyes = ana.seen.find(
        (m) =>
          m.senderDevice === a.device_id &&
          m.body?.type === "reaction" &&
          (m.body as { emoji: string }).emoji === "👀",
      );
      const firstQueued = activityOf(ana, a.device_id).find((x) => x.body.phase === "queued");
      return (
        reactionLog(ana, a.device_id, trigger.id)[0] === "add 👀" &&
        (eyes?.ts ?? Infinity) - trigger.ts < 1000 &&
        (eyes?.ts ?? Infinity) <= (firstQueued?.ts ?? 0)
      );
    };
    expect(waiting.map(eyesBeforeWait)).toEqual([true, true]);
  }, 40000);
});
