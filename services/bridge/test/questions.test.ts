import { afterEach, describe, expect, it } from "vitest";
import { clearTurnHooks } from "../src/agents/turn-hooks.js";
import { buildApp } from "../src/app.js";
import { clearRegisteredTools, registeredTools, type ToolCtx } from "../src/mcp/registry.js";
import { plugin } from "../src/plugins/approvals.js";
import { approvalsWorld } from "./approvals-fixture.js";

const bearer = (u: string) => ({ authorization: `Bearer tok-${u}` });
const stoppers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const s of stoppers.splice(0)) await s();
});

async function setup() {
  clearRegisteredTools();
  clearTurnHooks();
  const w = await approvalsWorld();
  await plugin.init?.({
    db: w.db,
    relayAdmin: { setMember: async () => {} },
    relayInternalUrl: "http://127.0.0.1:1",
    ticketFor: async () => "",
    opsSimUrl: "http://127.0.0.1:1",
    agentHost: w.host,
    log: () => {},
  });
  const app = buildApp({
    db: w.db,
    relayAdmin: { setMember: async () => {} },
    agentHost: w.host,
    plugins: [plugin],
  });
  stoppers.push(
    () => app.close(),
    () => plugin.stop?.(),
  );
  const ask = async (question: string, options?: string[]) => {
    const t = registeredTools("general").find((x) => x.name === "ask_user");
    if (!t) throw new Error("ask_user is not registered for general");
    const ctx: ToolCtx = {
      db: w.db,
      agentId: "nora",
      template: "general",
      chatId: "c1",
      requesterUserId: "bob",
      opsSimUrl: "http://127.0.0.1:1",
      turn: {
        turnId: "turn1",
        agentId: "nora",
        agentName: "Nora",
        chatId: "c1",
        replyTo: "root1",
        triggerMessageId: "root1",
        requesterUserId: "bob",
        trigger: "mention",
        prompt: "",
        noTaught: false,
      },
    };
    return t.run(ctx, { question, ...(options ? { options } : {}) });
  };
  return { ...w, app, ask };
}

describe("ask_user questions (T8)", () => {
  it("ask_user posts the card with meta.question in the thread and returns asked", async () => {
    const w = await setup();
    const out = JSON.parse(await w.ask("Which branch?", ["main", "release-7.4"]));
    const [q] = await w.db.query<{ id: string; status: string; requester_user_id: string }>(
      "select id, status, requester_user_id from sa.questions",
    );
    expect(out).toEqual({
      status: "asked",
      question_id: q?.id,
      message: "I asked Bob. End your turn; their answer arrives as the next message.",
    });
    expect(q).toMatchObject({ status: "open", requester_user_id: "bob" });
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]).toMatchObject({
      agentId: "nora",
      chatId: "c1",
      text: "Which branch?",
      opts: {
        replyTo: "root1",
        meta: { question: { id: q?.id, options: ["main", "release-7.4"] } },
      },
    });
  });

  it("only the requester answers, the first answer wins and starts exactly one answer turn", async () => {
    const w = await setup();
    await w.ask("Which branch?", ["main", "release-7.4"]);
    const [q] = await w.db.query<{ id: string }>("select id from sa.questions");
    const url = `/api/questions/${q?.id}/answer`;
    const other = await w.app.inject({
      method: "POST",
      url,
      headers: bearer("ana"),
      payload: { option: 0 },
    });
    expect(other.statusCode).toBe(404);
    expect(w.proactive).toHaveLength(0);
    const [first, second] = await Promise.all([
      w.app.inject({ method: "POST", url, headers: bearer("bob"), payload: { option: 1 } }),
      w.app.inject({ method: "POST", url, headers: bearer("bob"), payload: { text: "main" } }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect(w.proactive).toHaveLength(1);
    expect(w.proactive[0]).toMatchObject({
      agentId: "nora",
      chatId: "c1",
      kind: "answer",
      requesterUserId: "bob",
      replyTo: "root1",
    });
    const [after] = await w.db.query<{ status: string; answer: string }>(
      "select status, answer from sa.questions",
    );
    expect(after?.status).toBe("answered");
    expect(w.proactive[0]?.prompt).toBe(
      `Bob answered your question "Which branch?": ${after?.answer}`,
    );
  });

  it("an expired question answers 409 closed, and a third open question in the thread is refused", async () => {
    const w = await setup();
    await w.ask("First?");
    await w.ask("Second?");
    const third = await w.ask("Third?");
    expect(third).toBe("You already asked two questions here; wait for the answers.");
    expect(await w.db.query("select id from sa.questions")).toHaveLength(2);
    const [q] = await w.db.query<{ id: string }>(
      "select id from sa.questions where question = 'First?'",
    );
    await w.db.query(
      "update sa.questions set expires_at = now() - interval '1 second' where id = $1",
      [q?.id],
    );
    const late = await w.app.inject({
      method: "POST",
      url: `/api/questions/${q?.id}/answer`,
      headers: bearer("bob"),
      payload: { text: "too late" },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: "closed" });
    expect(w.proactive).toHaveLength(0);
  });
});
