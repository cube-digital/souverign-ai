import { afterEach, describe, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import type { AgentRuntime } from "../src/agents/runtime.js";
import {
  activityOf,
  addPersonalAgent,
  auth,
  createWorld,
  metaOf,
  person,
  reactionsNet,
  rekey,
  replyToOf,
  sent,
  sleep,
  startChat,
  textOf,
  textsFrom,
  type World,
} from "./teammates-fixture.js";

const LIMIT =
  "I stopped after 3 minutes without finishing. I can only read through my tools and cannot create files or run commands. Try a narrower question.";

let w: World;
afterEach(async () => {
  await w?.close();
});

async function slowTurn() {
  w = await createWorld(new EchoRuntime({ delayMs: 2000 }));
  const ana = await person(w, "ana");
  const bob = await person(w, "bob");
  const chat = await startChat(w, ana, "Ops room", [bob]);
  const scout = await addPersonalAgent(w, ana, chat, "Scout");
  await rekey(w, chat, ana, [ana, bob], [scout]);
  await ana.engine.sendText(chat, "@Scout do the long job");
  const trigger = await sent(ana, "@Scout do the long job");
  await expect
    .poll(() => activityOf(ana, scout.device_id).find((a) => a.body.turn_id)?.body.turn_id, {
      timeout: 8000,
    })
    .toBeTruthy();
  const turnId = activityOf(ana, scout.device_id).find((a) => a.body.turn_id)?.body
    .turn_id as string;
  return { ana, bob, chat, scout, trigger, turnId };
}

describe("stopping a turn", () => {
  it("only the requester can stop it; anyone else is refused and the turn still finishes", async () => {
    const { ana, bob, scout, trigger, turnId } = await slowTurn();

    expect(w.host.stopTurn?.(turnId, "bob")).toBe("forbidden");
    expect(w.host.stopTurn?.("no-such-turn", "ana")).toBe("not_found");
    const viaRoute = await w.app.inject({
      method: "POST",
      url: `/api/turns/${turnId}/stop`,
      headers: auth(bob.token),
    });
    const unknown = await w.app.inject({
      method: "POST",
      url: "/api/turns/no-such-turn/stop",
      headers: auth(ana.token),
    });
    expect(viaRoute.statusCode).toBe(403);
    expect(unknown.statusCode).toBe(404);

    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 10000 }).toBe(1);
    expect(textOf(textsFrom(ana, scout.device_id)[0]!).startsWith("echo:")).toBe(true);
    await expect
      .poll(() => reactionsNet(ana, scout.device_id, trigger.id), { timeout: 5000 })
      .toEqual(["✅"]);
  }, 25000);

  it("stopped by the requester: the thread says so, ends in ⏹️, and the model posts nothing after", async () => {
    const { ana, scout, trigger, turnId } = await slowTurn();

    const r = await w.app.inject({
      method: "POST",
      url: `/api/turns/${turnId}/stop`,
      headers: auth(ana.token),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ stopped: true });

    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 5000 }).toBe(1);
    await sleep(3500);
    const posted = textsFrom(ana, scout.device_id);
    expect(posted).toHaveLength(1);
    expect(textOf(posted[0]!)).toBe("Stopped by Ana.");
    expect(replyToOf(posted[0]!)).toBe(trigger.id);
    expect(metaOf(posted[0]!)?.stopped_by).toBe("Ana");
    expect(reactionsNet(ana, scout.device_id, trigger.id)).toEqual(["⏹️"]);
    const phases = activityOf(ana, scout.device_id).map((a) => a.body.phase);
    expect(phases[phases.length - 1]).toBe("stopped");
    expect(w.host.stopTurn?.(turnId, "ana")).toBe("not_found");
  }, 25000);

  it("a model timeout posts the limit message in the thread with ⚠️ and does not mark the agent as failed", async () => {
    const timeout: AgentRuntime = {
      ensureStarted: async () => {},
      stop: async () => {},
      stopAll: async () => {},
      chat: async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
    };
    w = await createWorld(timeout);
    const ana = await person(w, "ana");
    const chat = await startChat(w, ana, "Ops room");
    const scout = await addPersonalAgent(w, ana, chat, "Scout");
    await rekey(w, chat, ana, [ana], [scout]);
    const before = (
      await w.db.query<{ status: string }>("select status from sa.agents where id = $1", [scout.id])
    )[0]?.status;

    await ana.engine.sendText(chat, "@Scout create a file for me");
    const trigger = await sent(ana, "@Scout create a file for me");
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(1);

    const reply = textsFrom(ana, scout.device_id)[0]!;
    expect(textOf(reply)).toBe(LIMIT);
    expect(replyToOf(reply)).toBe(trigger.id);
    await expect
      .poll(() => reactionsNet(ana, scout.device_id, trigger.id), { timeout: 5000 })
      .toEqual(["⚠️"]);
    const after = await w.db.query<{ status: string }>(
      "select status from sa.agents where id = $1",
      [scout.id],
    );
    expect(after[0]?.status).toBe(before);
  }, 20000);
});
