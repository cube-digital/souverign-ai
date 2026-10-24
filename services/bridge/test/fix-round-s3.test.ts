import { afterEach, describe, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import { ToolLog } from "../src/mcp/tool-log.js";
import { auth, createWorld, person, startChat, type World } from "./teammates-fixture.js";

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe("tool context belongs to one turn", () => {
  it("refuses tool calls when no turn is running or when they name another turn", () => {
    const log = new ToolLog();
    log.begin("a1", "c1", { turnId: "t1" });
    expect(log.accepts("a1", "t1")).toBe(true);
    expect(log.accepts("a1", "t0")).toBe(false);
    log.end("a1");
    expect(log.accepts("a1", "t1")).toBe(false);
    expect(log.accepts("a1")).toBe(false);
  });
});

describe("removing a member", () => {
  it("removes their personal agents even when the person was already removed", async () => {
    w = await createWorld(new EchoRuntime(), ["ana", "bob"]);
    const ana = await person(w, "ana");
    const bob = await person(w, "bob");
    const chat = await startChat(w, ana, "Ops room", [bob]);
    const agent = (
      await w.app.inject({
        method: "POST",
        url: "/api/agents",
        headers: auth(bob.token),
        payload: { name: "Bobby", template: "general", soul: "" },
      })
    ).json();
    const join = () =>
      w?.db.query(
        `insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'agent', $2, 'member')
         on conflict (chat_id, member_type, member_id) do update set removed_at = null`,
        [chat, agent.id],
      );
    const agentActive = async () =>
      (
        await w!.db.query(
          "select 1 from sa.chat_members where chat_id = $1 and member_type = 'agent' and member_id = $2 and removed_at is null",
          [chat, agent.id],
        )
      ).length;
    const remove = () =>
      w!.app.inject({
        method: "DELETE",
        url: `/api/chats/${chat}/members/bob`,
        headers: auth(ana.token),
      });

    await join();
    expect((await remove()).statusCode).toBe(200);
    expect(await agentActive()).toBe(0);

    // a half-finished earlier removal: the person is gone but the agent is still a member
    await join();
    expect((await remove()).statusCode).toBe(200);
    expect(await agentActive()).toBe(0);
  });
});
