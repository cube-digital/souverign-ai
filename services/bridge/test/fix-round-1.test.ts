import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import {
  addPersonalAgent,
  auth,
  createWorld,
  person,
  startChat,
  type World,
} from "./teammates-fixture.js";

let w: World;
beforeEach(async () => {
  w = await createWorld(new EchoRuntime(), ["ana", "bob"]);
});
afterEach(() => w.close());

describe("review fixes", () => {
  it("refuses an epoch claim far past the current epoch and rate-limits claims per chat", async () => {
    const ana = await person(w, "ana");
    const chat = await startChat(w, ana, "Room");
    const claim = (min: number) =>
      w.app.inject({
        method: "POST",
        url: `/api/chats/${chat}/epoch`,
        headers: auth(ana.token),
        payload: { min },
      });

    expect((await claim(1_000_000)).statusCode).toBe(400);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await claim(1)).statusCode);
    expect(codes.filter((c) => c === 200).length).toBeLessThan(12);
    expect(codes.at(-1)).toBe(429);
  });

  it("takes a removed person's personal agents out of the chat with them", async () => {
    const ana = await person(w, "ana");
    const bob = await person(w, "bob");
    const chat = await startChat(w, ana, "Team", [bob]);
    // the member adds only their own agent, which needs the chat owner: make bob an owner-less case via ana
    const rex = await addPersonalAgent(w, ana, chat, "Rex");
    await w.db.query("update sa.agents set owner_user_id = 'bob' where id = $1", [rex.id]);

    const r = await w.app.inject({
      method: "DELETE",
      url: `/api/chats/${chat}/members/bob`,
      headers: auth(ana.token),
    });

    expect(r.statusCode).toBe(200);
    const left = await w.db.query(
      "select 1 from sa.chat_members where chat_id = $1 and member_type = 'agent' and removed_at is null",
      [chat],
    );
    expect(left).toHaveLength(0);
  });

  it("creates one DM when the same request arrives twice at once", async () => {
    const ana = await person(w, "ana");
    const agent = (
      await w.app.inject({
        method: "POST",
        url: "/api/agents",
        headers: auth(ana.token),
        payload: { name: "Scout", template: "general", soul: "" },
      })
    ).json();
    const dm = () =>
      w.app.inject({ method: "POST", url: `/api/agents/${agent.id}/dm`, headers: auth(ana.token) });

    const [a, b] = await Promise.all([dm(), dm()]);

    expect(a.json().id).toBe(b.json().id);
    const chats = await w.db.query("select id from sa.chats where kind = 'dm'");
    expect(chats).toHaveLength(1);
  });
});
