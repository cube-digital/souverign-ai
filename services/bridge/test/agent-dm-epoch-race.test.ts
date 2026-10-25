import { afterEach, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import {
  auth,
  createWorld,
  insertWorkspaceAgent,
  type Person,
  person,
  sleep,
  textOf,
  textsFrom,
  type World,
} from "./teammates-fixture.js";

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

type Dm = { id: string; key_epoch: number; members: { devices: never[] }[] };
async function openDm(world: World, p: Person, agentId: string): Promise<Dm> {
  const r = await world.app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/dm`,
    headers: auth(p.token),
  });
  expect(r.statusCode).toBe(200);
  return r.json() as Dm;
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(30);
};

it("a second device opening the DM before the agent stored the first key gets epoch 2, once, and the agent reads both devices", async () => {
  w = await createWorld(new EchoRuntime(), ["ana"]);
  const ops = await insertWorkspaceAgent(w, {
    id: "ag-ops",
    name: "Ops",
    rosterId: "ops",
    template: "ops",
  });
  const first = await person(w, "ana");
  const second = await person(w, "ana");
  const dm = await openDm(w, first, ops.id);
  expect(dm.key_epoch).toBe(1);

  // the agent holds no key yet: epoch 1 may be in flight from the first device
  const again = await openDm(w, second, ops.id);
  expect(again.id).toBe(dm.id);
  expect(again.key_epoch).toBe(2);
  const third = await openDm(w, second, ops.id);
  expect(third.key_epoch).toBe(2);

  await first.engine.start([dm.id]);
  await first.engine.createEpoch(
    dm.id,
    dm.members.flatMap((m) => m.devices),
  );
  await first.engine.sendText(dm.id, "first device ALPHA");
  await until(() => textsFrom(first, ops.device_id).some((m) => textOf(m).includes("ALPHA")));
  expect(textsFrom(first, ops.device_id).map(textOf).join(" ")).toContain("ALPHA");

  await second.engine.start([dm.id]);
  await second.engine.createEpoch(
    dm.id,
    again.members.flatMap((m) => m.devices),
    again.key_epoch,
  );
  await second.engine.sendText(dm.id, "second device BRAVO");
  await until(() => textsFrom(second, ops.device_id).some((m) => textOf(m).includes("BRAVO")));
  expect(textsFrom(second, ops.device_id).map(textOf).join(" ")).toContain("BRAVO");
}, 25000);
