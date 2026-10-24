import { ROSTER } from "@sa/protocol/roster";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import type { AgentRuntime, ChatMessage, RuntimeAgent } from "../src/agents/runtime.js";
import { forceFirstTool } from "../src/agents/turn-policy.js";
import {
  activityOf,
  addPersonalAgent,
  auth,
  createWorld,
  insertWorkspaceAgent,
  joinWorkspaceAgent,
  metaOf,
  person,
  reactionLog,
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

let w: World;
afterEach(async () => {
  vi.useRealTimers();
  await w?.close();
});

/** Echo, but each agent's content can be overridden and every runtime call is counted. */
function scripted(content: Record<string, string> = {}) {
  const echo = new EchoRuntime();
  const calls: { agent: string; forced: boolean }[] = [];
  const runtime: AgentRuntime = {
    ensureStarted: async () => {},
    stop: async () => {},
    stopAll: async () => {},
    chat: async (agent: RuntimeAgent, chatId: string, messages: ChatMessage[]) => {
      calls.push({ agent: agent.name, forced: forceFirstTool(agent.id) });
      const fixed = content[agent.name];
      return fixed ? { content: fixed } : echo.chat(agent, chatId, messages);
    },
  };
  return { runtime, calls };
}

describe("threads and tags", () => {
  it("a tag is answered in a thread under the message, and every tagged agent shares that thread", async () => {
    w = await createWorld(new EchoRuntime());
    const ana = await person(w, "ana");
    const chat = await startChat(w, ana, "Ops room");
    const scout = await addPersonalAgent(w, ana, chat, "Scout");
    const rex = await addPersonalAgent(w, ana, chat, "Rex");
    await rekey(w, chat, ana, [ana], [scout, rex]);

    await ana.engine.sendText(chat, "@Scout @Rex status please");
    const root = await sent(ana, "@Scout @Rex status please");

    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(1);
    await expect.poll(() => textsFrom(ana, rex.device_id).length, { timeout: 8000 }).toBe(1);
    expect(replyToOf(textsFrom(ana, scout.device_id)[0]!)).toBe(root.id);
    expect(replyToOf(textsFrom(ana, rex.device_id)[0]!)).toBe(root.id);
  }, 20000);

  it("shows 👀 then ✅ on the trigger, live status with the turn id, and receipts on the reply", async () => {
    w = await createWorld(new EchoRuntime());
    const ana = await person(w, "ana");
    const chat = await startChat(w, ana, "Ops room");
    const scout = await addPersonalAgent(w, ana, chat, "Scout");
    await rekey(w, chat, ana, [ana], [scout]);

    await ana.engine.sendText(chat, "background note");
    await ana.engine.sendText(chat, "@Scout summarise");
    const trigger = await sent(ana, "@Scout summarise");
    await expect
      .poll(() => reactionsNet(ana, scout.device_id, trigger.id), { timeout: 8000 })
      .toEqual(["✅"]);

    const log = reactionLog(ana, scout.device_id, trigger.id);
    expect(log[0]).toBe("add 👀");
    expect(log).toHaveLength(3);
    expect(log).toEqual(expect.arrayContaining(["remove 👀", "add ✅"]));

    const reply = textsFrom(ana, scout.device_id)[0]!;
    const meta = metaOf(reply);
    expect(replyToOf(reply)).toBe(trigger.id);
    expect(meta?.model).toBe("echo");
    expect(meta?.local).toBe(true);
    expect(meta?.trigger).toBe("mention");
    expect(meta?.tools).toEqual([]);
    expect(Number.isInteger(meta?.ms)).toBe(true);
    expect(Number.isInteger(meta?.read)).toBe(true);
    expect(meta?.read).toBeGreaterThanOrEqual(1);
    expect(typeof meta?.turn_id).toBe("string");

    const acts = activityOf(ana, scout.device_id);
    expect(acts[0]?.body.phase).toBe("thinking");
    expect(acts[acts.length - 1]?.body.phase).toBe("done");
    expect(new Set(acts.map((a) => a.body.turn_id))).toEqual(new Set([meta?.turn_id]));
    expect(new Set(acts.map((a) => a.body.reply_to))).toEqual(new Set([trigger.id]));
    expect(new Set(acts.map((a) => a.body.requester))).toEqual(new Set(["ana"]));
  }, 20000);

  it("an untagged follow-up from the same person within 10 minutes wakes exactly one agent; others and late ones wake none", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    w = await createWorld(new EchoRuntime());
    const ana = await person(w, "ana");
    const bob = await person(w, "bob");
    const chat = await startChat(w, ana, "Ops room", [bob]);
    const scout = await addPersonalAgent(w, ana, chat, "Scout");
    const rex = await addPersonalAgent(w, ana, chat, "Rex");
    await rekey(w, chat, ana, [ana, bob], [scout, rex]);
    const replies = () =>
      textsFrom(ana, scout.device_id).length + textsFrom(ana, rex.device_id).length;

    await ana.engine.sendText(chat, "@Scout @Rex look at this");
    const root = await sent(ana, "@Scout @Rex look at this");
    await expect.poll(replies, { timeout: 8000 }).toBe(2);

    await ana.engine.sendText(chat, "and the second part?", undefined, { replyTo: root.id });
    await expect.poll(replies, { timeout: 12000 }).toBe(3);
    await sleep(4500);
    expect(replies()).toBe(3);

    await bob.engine.sendText(chat, "bob chimes in", undefined, { replyTo: root.id });
    await sleep(4500);
    expect(replies()).toBe(3);

    vi.setSystemTime(Date.now() + 11 * 60_000);
    await ana.engine.sendText(chat, "one more thing", undefined, { replyTo: root.id });
    await sleep(2000);
    expect(replies()).toBe(3);
  }, 40000);

  it("every message in a DM with an agent is answered, top-level, or in the thread it was sent in", async () => {
    w = await createWorld(new EchoRuntime());
    const ana = await person(w, "ana");
    const ops = await insertWorkspaceAgent(w, {
      id: "agent-ops-000000000000",
      name: "Ops",
      rosterId: "ops",
      template: "ops",
    });
    const dm = (
      await w.app.inject({
        method: "POST",
        url: `/api/agents/${ops.id}/dm`,
        headers: auth(ana.token),
      })
    ).json();
    await ana.engine.start([dm.id]);
    await rekey(w, dm.id, ana, [ana], [ops]);

    await ana.engine.sendText(dm.id, "hello with no tag at all");
    const first = await sent(ana, "hello with no tag at all");
    await expect.poll(() => textsFrom(ana, ops.device_id).length, { timeout: 8000 }).toBe(1);
    const top = textsFrom(ana, ops.device_id)[0]!;
    expect(replyToOf(top)).toBeUndefined();
    expect(metaOf(top)?.trigger).toBe("dm");

    await ana.engine.sendText(dm.id, "and in the thread", undefined, { replyTo: first.id });
    await expect.poll(() => textsFrom(ana, ops.device_id).length, { timeout: 12000 }).toBe(2);
    expect(replyToOf(textsFrom(ana, ops.device_id)[1]!)).toBe(first.id);
  }, 30000);

  it("never answers an agent's message or a message older than 5 minutes", async () => {
    const { runtime } = scripted({ Scout: "note to self @Scout, handing over to @Quinn" });
    w = await createWorld(runtime);
    const ana = await person(w, "ana");
    const chat = await startChat(w, ana, "Ops room");
    const scout = await addPersonalAgent(w, ana, chat, "Scout");
    const quinn = await addPersonalAgent(w, ana, chat, "Quinn");
    await rekey(w, chat, ana, [ana], [scout, quinn]);

    await ana.engine.sendText(chat, "@Scout please hand over");
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(1);
    await sleep(4000);
    expect(textsFrom(ana, scout.device_id)).toHaveLength(1);
    expect(textsFrom(ana, quinn.device_id)).toHaveLength(0);

    await ana.engine.sendText(chat, "@Quinn old news", undefined, {
      ts: Date.now() - 6 * 60_000,
    });
    await ana.engine.sendText(chat, "@Quinn fresh news");
    const fresh = await sent(ana, "@Quinn fresh news");
    await expect.poll(() => textsFrom(ana, quinn.device_id).length, { timeout: 8000 }).toBe(1);
    await sleep(1500);
    expect(textsFrom(ana, quinn.device_id)).toHaveLength(1);
    expect(replyToOf(textsFrom(ana, quinn.device_id)[0]!)).toBe(fresh.id);
  }, 30000);

  it("answers 'what can you access here?' from the bridge without calling the model", async () => {
    const { runtime, calls } = scripted();
    w = await createWorld(runtime);
    const ana = await person(w, "ana");
    const chat = await startChat(w, ana, "Ops room");
    const ops = await insertWorkspaceAgent(w, {
      id: "agent-ops-000000000000",
      name: "Ops",
      rosterId: "ops",
      template: "ops",
    });
    await joinWorkspaceAgent(w, chat, ops);
    await rekey(w, chat, ana, [ana], [ops]);

    await ana.engine.sendText(chat, "@Ops what can you access here?");
    const trigger = await sent(ana, "@Ops what can you access here?");
    await expect.poll(() => textsFrom(ana, ops.device_id).length, { timeout: 8000 }).toBe(1);

    const reply = textsFrom(ana, ops.device_id)[0]!;
    const text = textOf(reply);
    const opsTools = ROSTER.find((r) => r.id === "ops")!.tools;
    expect(text.startsWith('In "Ops room" I can read the messages posted since I joined on ')).toBe(
      true,
    );
    expect(text).toContain("I cannot read other chats, earlier messages");
    expect(text).toContain("\nTools:\n");
    expect(text).toContain("- cluster_health: ");
    expect(opsTools.every((t) => text.includes(`- ${t}`))).toBe(true);
    expect(text.endsWith("Everything runs on this Mac.")).toBe(true);
    expect(metaOf(reply)?.trigger).toBe("access");
    expect(metaOf(reply)?.local).toBe(true);
    expect(replyToOf(reply)).toBe(trigger.id);
    expect(calls).toEqual([]);
  }, 20000);

  it("posts a proactive turn top-level with its trigger, and declines for an agent that is not a member", async () => {
    w = await createWorld(new EchoRuntime());
    const ana = await person(w, "ana");
    const chat = await startChat(w, ana, "Ops room");
    const scout = await addPersonalAgent(w, ana, chat, "Scout");
    const stranger = await addPersonalAgent(w, ana, await startChat(w, ana, "Other"), "Rex");
    await rekey(w, chat, ana, [ana], [scout]);

    const posted = await w.host.runProactive?.({
      agentId: scout.id,
      chatId: chat,
      prompt: "Check the alerts",
      kind: "alert",
    });
    const skipped = await w.host.runProactive?.({
      agentId: stranger.id,
      chatId: chat,
      prompt: "Check the alerts",
      kind: "alert",
    });

    expect(posted).toBe(true);
    expect(skipped).toBe(false);
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(1);
    const reply = textsFrom(ana, scout.device_id)[0]!;
    expect(replyToOf(reply)).toBeUndefined();
    expect(metaOf(reply)?.trigger).toBe("alert");
    expect(textOf(reply)).toContain("Check the alerts");
    const reactions = ana.seen.filter(
      (m) => m.senderDevice === scout.device_id && m.body?.type === "reaction",
    );
    expect(reactions).toHaveLength(0);
  }, 20000);

  it("forces the first tool round for a tag and not for an untagged follow-up", async () => {
    const { runtime, calls } = scripted();
    w = await createWorld(runtime);
    const ana = await person(w, "ana");
    const chat = await startChat(w, ana, "Ops room");
    const scout = await addPersonalAgent(w, ana, chat, "Scout");
    await rekey(w, chat, ana, [ana], [scout]);

    await ana.engine.sendText(chat, "@Scout first question");
    const root = await sent(ana, "@Scout first question");
    await expect.poll(() => calls.length, { timeout: 8000 }).toBe(1);
    await expect
      .poll(() => reactionsNet(ana, scout.device_id, root.id), { timeout: 8000 })
      .toEqual(["✅"]);
    await ana.engine.sendText(chat, "and a follow-up", undefined, { replyTo: root.id });
    await expect.poll(() => calls.length, { timeout: 12000 }).toBe(2);

    expect(calls.map((c) => c.forced)).toEqual([true, false]);
  }, 30000);
});
