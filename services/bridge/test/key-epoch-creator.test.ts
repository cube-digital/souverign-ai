import { afterEach, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import { makeCatchup } from "../src/proactive/catchup.js";
import {
  auth,
  createWorld,
  insertWorkspaceAgent,
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

/** Like the web (agentDm.ts): open the DM through the API, then mint epoch 1 without a claim. */
async function openDm(world: World, token: string, agentId: string) {
  const r = await world.app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/dm`,
    headers: auth(token),
  });
  expect(r.statusCode).toBe(200);
  return r.json() as { id: string; key_epoch: number; members: { devices: never[] }[] };
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(30);
};

it("an agent answers in a new DM keyed by the creator's unclaimed epoch 1", async () => {
  w = await createWorld(new EchoRuntime(), ["ana"]);
  const ana = await person(w, "ana");
  const ops = await insertWorkspaceAgent(w, {
    id: "ag-ops",
    name: "Ops",
    rosterId: "ops",
    template: "ops",
  });
  const dm = await openDm(w, ana.token, ops.id);
  expect(dm.key_epoch).toBe(1);

  await ana.engine.start([dm.id]);
  expect(
    await ana.engine.createEpoch(
      dm.id,
      dm.members.flatMap((m) => m.devices),
    ),
  ).toBe(1);
  await ana.engine.sendText(dm.id, "status of the gateway?");

  await until(() => textsFrom(ana, ops.device_id).length > 0);
  expect(textsFrom(ana, ops.device_id).map(textOf).join(" ")).toContain("status of the gateway?");
}, 20000);

it("Scribe's welcome lands in a new DM keyed by the creator's unclaimed epoch 1", async () => {
  w = await createWorld(new EchoRuntime(), ["ana"]);
  const ana = await person(w, "ana");
  const scribe = await insertWorkspaceAgent(w, {
    id: "ag-scribe",
    name: "Scribe",
    rosterId: "scribe",
    template: "scribe",
  });
  const dm = await openDm(w, ana.token, scribe.id);
  await ana.engine.start([dm.id]);
  await ana.engine.createEpoch(
    dm.id,
    dm.members.flatMap((m) => m.devices),
  );

  const catchup = makeCatchup({ db: w.db, agentHost: w.host, log: () => {} });
  await catchup.onAgentDm("ana", scribe.id, dm.id, true);

  await until(() => textsFrom(ana, scribe.device_id).length > 0);
  expect(textsFrom(ana, scribe.device_id)).toHaveLength(1);
}, 20000);

it("a new human chat starts at key_epoch 1 and the next claim hands out epoch 2", async () => {
  w = await createWorld(new EchoRuntime(), ["ana"]);
  const ana = await person(w, "ana");
  const chat = (
    await w.app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(ana.token),
      payload: { title: "Team", member_user_ids: [] },
    })
  ).json();
  expect(chat.key_epoch).toBe(1);
  const claim = await w.app.inject({
    method: "POST",
    url: `/api/chats/${chat.id}/epoch`,
    headers: auth(ana.token),
    payload: { min: 2 },
  });
  expect(claim.json()).toEqual({ epoch: 2 });
}, 20000);
