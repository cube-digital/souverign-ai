import { afterEach, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import { addTurnHooks, clearTurnHooks } from "../src/agents/turn-hooks.js";
import {
  addPersonalAgent,
  createWorld,
  person,
  rekey,
  sleep,
  startChat,
  type World,
} from "./teammates-fixture.js";

let w: World | undefined;
afterEach(async () => {
  clearTurnHooks();
  await w?.close();
  w = undefined;
});

it("stopAll waits for onStored hooks still running, so they finish before the pool closes", async () => {
  w = await createWorld(new EchoRuntime());
  const world = w;
  const ana = await person(world, "ana");
  const chat = await startChat(world, ana, "Ops room");
  const scout = await addPersonalAgent(world, ana, chat, "Scout");
  await rekey(world, chat, ana, [ana], [scout]);

  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let started = 0;
  const finished: string[] = [];
  addTurnHooks({
    name: "slow-ingest",
    onStored: async (m) => {
      if (m.senderDevice !== ana.deviceId) return;
      started++;
      await gate;
      const [row] = await world.db.query<{ n: number }>("select 1 as n");
      finished.push(`${m.id}:${row?.n}`);
    },
  });

  await ana.engine.sendText(chat, "note to ingest");
  await expect.poll(() => started, { timeout: 8000 }).toBe(1);

  let stopped = false;
  const stopping = world.host.stopAll().then(() => {
    stopped = true;
  });
  await sleep(50);
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatch(/:1$/);
}, 20000);
