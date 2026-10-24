import { ROSTER } from "@sa/protocol/roster";
import { afterEach, describe, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import {
  addPersonalAgent,
  createWorld,
  insertWorkspaceAgent,
  metaOf,
  person,
  rekey,
  replyToOf,
  sent,
  sleep,
  startChat,
  textOf,
  textsFrom,
  type World,
} from "./teammates-fixture.js";

type Metrics = {
  turn_id: string;
  trigger: string;
  outcome: string;
  thread_root: string | null;
  requester_user_id: string | null;
  eyes_ms: number | null;
  first_token_ms: number | null;
  done_ms: number | null;
  tools: number;
  reask: boolean;
  feedback: string | null;
};

let w: World;
afterEach(async () => {
  await w?.close();
});

const rows = (agentId: string) =>
  w.db.query<Metrics>("select * from sa.turn_metrics where agent_id = $1 order by created_at", [
    agentId,
  ]);

async function oneAgentChat() {
  w = await createWorld(new EchoRuntime());
  const ana = await person(w, "ana");
  const chat = await startChat(w, ana, "Ops room");
  const scout = await addPersonalAgent(w, ana, chat, "Scout");
  await rekey(w, chat, ana, [ana], [scout]);
  return { ana, chat, scout };
}

describe("turn metrics", () => {
  it("records one row per finished turn with ids and timings and none of the text", async () => {
    const { ana, chat, scout } = await oneAgentChat();

    await ana.engine.sendText(chat, "@Scout METRICS-SENTINEL-4471 how are we doing");
    const trigger = await sent(ana, "@Scout METRICS-SENTINEL-4471 how are we doing");
    await expect.poll(async () => (await rows(scout.id)).length, { timeout: 8000 }).toBe(1);

    const [row] = await rows(scout.id);
    const reply = textsFrom(ana, scout.device_id)[0]!;
    expect(textOf(reply)).toContain("METRICS-SENTINEL-4471");
    expect(row).toMatchObject({
      turn_id: metaOf(reply)?.turn_id,
      trigger: "mention",
      outcome: "done",
      thread_root: trigger.id,
      requester_user_id: "ana",
      tools: 0,
      reask: false,
      feedback: null,
    });
    expect(Number.isInteger(row?.eyes_ms)).toBe(true);
    expect(row?.eyes_ms).toBeLessThan(1000);
    expect(Number.isInteger(row?.first_token_ms)).toBe(true);
    expect(row?.done_ms).toBeGreaterThanOrEqual(row?.first_token_ms ?? Infinity);
    expect(JSON.stringify(row)).not.toContain("SENTINEL");
    expect(JSON.stringify(row)).not.toContain("how are we doing");
  }, 20000);

  it("flags the previous turn as re-asked when the same person asks the same agent again in the thread within 10 minutes", async () => {
    const { ana, chat, scout } = await oneAgentChat();

    await ana.engine.sendText(chat, "@Scout first try");
    const root = await sent(ana, "@Scout first try");
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(1);
    await ana.engine.sendText(chat, "@Scout no, again please", undefined, { replyTo: root.id });
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 12000 }).toBe(2);
    await expect.poll(async () => (await rows(scout.id)).length, { timeout: 5000 }).toBe(2);

    const [first, second] = await rows(scout.id);
    const [r1, r2] = textsFrom(ana, scout.device_id);
    expect(replyToOf(r2!)).toBe(root.id);
    expect(first).toMatchObject({ turn_id: metaOf(r1!)?.turn_id, reask: true });
    expect(second).toMatchObject({ turn_id: metaOf(r2!)?.turn_id, reask: false });
  }, 30000);

  it("records a thumbs-down on the agent's reply as feedback and clears it when removed", async () => {
    const { ana, chat, scout } = await oneAgentChat();
    await ana.engine.sendText(chat, "@Scout rate me");
    await expect.poll(async () => (await rows(scout.id)).length, { timeout: 8000 }).toBe(1);
    const reply = textsFrom(ana, scout.device_id)[0]!;

    await ana.engine.sendReaction(chat, reply.id, "👎", "add");
    await expect
      .poll(async () => (await rows(scout.id))[0]?.feedback, { timeout: 5000 })
      .toBe("down");
    await ana.engine.sendReaction(chat, reply.id, "👎", "remove");
    await expect
      .poll(async () => (await rows(scout.id))[0]?.feedback, { timeout: 5000 })
      .toBeNull();
  }, 20000);
});

describe("join intro", () => {
  it("posts once per agent per chat with its example prompts, and never in a seeded room", async () => {
    w = await createWorld(new EchoRuntime());
    const ana = await person(w, "ana");
    const room = await startChat(w, ana, "Project");
    const seeded = await startChat(w, ana, "general");
    await w.db.query("update sa.chats set seed_key = 'general' where id = $1", [seeded]);
    const ops = await insertWorkspaceAgent(w, {
      id: "agent-ops-000000000000",
      name: "Ops",
      rosterId: "ops",
      template: "ops",
    });
    for (const chat of [room, seeded]) {
      await w.db.query(
        "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'agent', $2, 'member')",
        [chat, ops.id],
      );
      w.relay.addMember(chat, ops.device_id);
    }
    // not awaited: the intro waits for the chat key, which only arrives below
    void Promise.resolve(w.host.onAgentAdded(room, ops.id)).catch(() => {});
    void Promise.resolve(w.host.onAgentAdded(room, ops.id)).catch(() => {});
    void Promise.resolve(w.host.onAgentAdded(seeded, ops.id)).catch(() => {});
    await sleep(200);
    await rekey(w, room, ana, [ana], [ops]);
    await rekey(w, seeded, ana, [ana], [ops]);

    const intros = (chat: string) =>
      ana.seen.filter(
        (m) =>
          m.chatId === chat && m.senderDevice === ops.device_id && metaOf(m)?.trigger === "intro",
      );
    await expect.poll(() => intros(room).length, { timeout: 10000 }).toBe(1);
    await sleep(2000);

    const ops0 = ROSTER.find((r) => r.id === "ops")!;
    const intro = intros(room)[0]!;
    expect(textOf(intro)).toBe(`Ops · ${ops0.role}. Ask me, for example:`);
    expect(metaOf(intro)?.chips).toEqual(ops0.examples);
    expect(metaOf(intro)?.local).toBe(true);
    expect(intros(room)).toHaveLength(1);
    expect(intros(seeded)).toHaveLength(0);
    const stored = await w.db.query<{ chat_id: string }>(
      "select chat_id from sa.agent_intros where agent_id = $1",
      [ops.id],
    );
    expect(stored).toEqual([{ chat_id: room }]);
  }, 30000);
});
