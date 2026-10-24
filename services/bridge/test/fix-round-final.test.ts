import { afterEach, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import { humanMemberDevice } from "../src/workspace/custodian.js";
import {
  auth,
  createWorld,
  insertWorkspaceAgent,
  person,
  startChat,
  type World,
} from "./teammates-fixture.js";

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

it("any member of a group may remove a workspace agent, not another person's agent", async () => {
  w = await createWorld(new EchoRuntime(), ["ana", "bob", "cara"]);
  const ana = await person(w, "ana");
  const bob = await person(w, "bob");
  await person(w, "cara");
  const group = (
    await w.app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(ana.token),
      payload: { title: "Team", member_user_ids: ["bob", "cara"] },
    })
  ).json();
  expect(group.kind).toBe("group");
  const ops = await insertWorkspaceAgent(w, {
    id: "ag-ops",
    name: "Ops",
    rosterId: "ops",
    template: "ops",
  });
  const added = await w.app.inject({
    method: "POST",
    url: `/api/chats/${group.id}/agents`,
    headers: auth(bob.token),
    payload: { agent_id: ops.id },
  });
  expect(added.statusCode).toBe(200);
  const anaAgent = (
    await w.app.inject({
      method: "POST",
      url: "/api/agents",
      headers: auth(ana.token),
      payload: { name: "Scout", template: "general", soul: "" },
    })
  ).json();
  await w.app.inject({
    method: "POST",
    url: `/api/chats/${group.id}/agents`,
    headers: auth(ana.token),
    payload: { agent_id: anaAgent.id },
  });

  const remove = (agentId: string) =>
    w!.app.inject({
      method: "DELETE",
      url: `/api/chats/${group.id}/agents/${agentId}`,
      headers: auth(bob.token),
    });

  expect((await remove(ops.id)).statusCode).toBe(200);
  expect((await remove(anaAgent.id)).statusCode).toBe(404);
}, 20000);

it("the custodian trusts a member's key only up to the chat's claimed epoch", async () => {
  w = await createWorld(new EchoRuntime(), ["ana"]);
  const ana = await person(w, "ana");
  const chat = await startChat(w, ana, "Team");
  const trust = humanMemberDevice(w.db);

  expect(await trust(chat, ana.deviceId, 1)).toBe(true);
  expect(await trust(chat, ana.deviceId, 2)).toBe(false);
  expect(await trust(chat, "dev-stranger", 1)).toBe(false);
}, 20000);
