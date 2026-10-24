import { afterEach, describe, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import { renderSoul } from "../src/agents/hermes.js";
import {
  addTurnHooks,
  clearTurnHooks,
  FAIL_CLOSED_NOTICE,
  type StoredMessage,
  type TurnContext,
} from "../src/agents/turn-hooks.js";
import { clearRegisteredTools, registerTools, setToolDeps } from "../src/mcp/registry.js";
import {
  addPersonalAgent,
  createWorld,
  metaOf,
  person,
  reactionLog,
  rekey,
  replyToOf,
  sent,
  startChat,
  textOf,
  textsFrom,
  type World,
} from "./teammates-fixture.js";

let w: World;
afterEach(async () => {
  clearTurnHooks();
  clearRegisteredTools();
  await w?.close();
});

async function room() {
  w = await createWorld(new EchoRuntime());
  const ana = await person(w, "ana");
  const chat = await startChat(w, ana, "Ops room");
  const scout = await addPersonalAgent(w, ana, chat, "Scout");
  await rekey(w, chat, ana, [ana], [scout]);
  return { ana, chat, scout };
}

describe("turn hooks and registry seams", () => {
  it("runs onStored once per new message and gives file bodies a working loadFile", async () => {
    const { ana, chat, scout } = await room();
    const stored: StoredMessage[] = [];
    addTurnHooks({
      name: "probe",
      onStored: async (m) => {
        stored.push(m);
      },
    });
    const bytes = new Uint8Array([1, 2, 3, 250]);

    await ana.engine.sendText(chat, "plain note for the store");
    await ana.engine.sendFile(chat, { name: "n.bin", mime: "application/octet-stream", bytes });

    await expect
      .poll(() => stored.filter((m) => m.senderDevice === ana.deviceId).length, { timeout: 8000 })
      .toBe(2);
    const fromAna = stored.filter((m) => m.senderDevice === ana.deviceId);
    const text = fromAna.find((m) => m.body.type === "text")!;
    const file = fromAna.find((m) => m.body.type === "file")!;
    expect(text.agentId).toBe(scout.id);
    expect(text.chatId).toBe(chat);
    expect(text.body).toMatchObject({ type: "text", text: "plain note for the store" });
    expect(Number.isInteger(text.receivedAt)).toBe(true);
    expect(text.loadFile).toBeUndefined();
    expect(Array.from(await file.loadFile!())).toEqual([1, 2, 3, 250]);
  }, 20000);

  it("posts only the notice and merged meta on a hold, and the fail-closed notice when a hook throws", async () => {
    const { ana, chat, scout } = await room();
    addTurnHooks({
      name: "a-first",
      beforeReply: async () => ({ action: "post", meta: { model: "from-first" } }),
    });
    addTurnHooks({
      name: "b-second",
      beforeReply: async (_ctx, draft) => ({
        action: "hold",
        notice: "Held for approval.",
        meta: { held: `saw-${draft.meta.model}` },
      }),
    });

    await ana.engine.sendText(chat, "@Scout hold this one");
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(1);
    const held = textsFrom(ana, scout.device_id)[0]!;
    expect(textOf(held)).toBe("Held for approval.");
    expect(metaOf(held)?.held).toBe("saw-from-first");
    expect(metaOf(held)?.model).toBe("from-first");

    clearTurnHooks();
    addTurnHooks({
      name: "boom",
      beforeReply: async () => {
        throw new Error("policy exploded");
      },
    });
    await ana.engine.sendText(chat, "@Scout and this one");
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 12000 }).toBe(2);
    expect(textOf(textsFrom(ana, scout.device_id)[1]!)).toBe(FAIL_CLOSED_NOTICE);
    expect(textsFrom(ana, scout.device_id).some((m) => textOf(m).includes("echo:"))).toBe(false);
  }, 30000);

  it("postAs posts as the agent in the given thread with the meta, and returns null for a non-member", async () => {
    const { ana, chat, scout } = await room();
    const stranger = await addPersonalAgent(w, ana, await startChat(w, ana, "Other"), "Rex");
    await ana.engine.sendText(chat, "thread root");
    const root = await sent(ana, "thread root");

    const id = await w.host.postAs?.(scout.id, chat, "posted by the bridge", {
      replyTo: root.id,
      meta: { held: "appr-1" },
    });
    const none = await w.host.postAs?.(stranger.id, chat, "nope");

    expect(none).toBeNull();
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(1);
    const m = textsFrom(ana, scout.device_id)[0]!;
    expect(m.id).toBe(id);
    expect(textOf(m)).toBe("posted by the bridge");
    expect(replyToOf(m)).toBe(root.id);
    expect(metaOf(m)?.held).toBe("appr-1");
  }, 20000);

  it("echo !tool runs a tool registered for the agent's template, and other templates answer unknown tool", async () => {
    const { ana, chat, scout } = await room();
    setToolDeps({ db: w.db, opsSimUrl: "http://127.0.0.1:1", toolLog: w.toolLog });
    registerTools(
      ["general"],
      [
        {
          name: "shout",
          description: "Upper-cases q",
          properties: { q: { type: "string" } },
          required: ["q"],
          run: async (_ctx, args) => `LOUD ${String(args.q).toUpperCase()}`,
        },
      ],
    );
    registerTools(
      ["ops"],
      [
        {
          name: "ops_only",
          description: "Ops tool",
          properties: {},
          run: async () => "should never run",
        },
      ],
    );

    await ana.engine.sendText(chat, '@Scout !tool shout {"q":"hi"}');
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(1);
    const trace = metaOf(textsFrom(ana, scout.device_id)[0]!)?.trace ?? [];
    const calls = trace.filter((s: { kind: string }) => s.kind === "tool");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "tool", name: "shout", result: "LOUD HI" });

    await ana.engine.sendText(chat, "@Scout !tool ops_only {}");
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 12000 }).toBe(2);
    const trace2 = metaOf(textsFrom(ana, scout.device_id)[1]!)?.trace ?? [];
    const calls2 = trace2.filter((s: { kind: string }) => s.kind === "tool");
    expect(calls2).toHaveLength(1);
    expect(calls2[0]).toMatchObject({ name: "ops_only", result: "unknown tool: ops_only" });
  }, 30000);

  it("renders taught lessons into SOUL.md with who taught them", () => {
    const soul = renderSoul({
      id: "agent-soul-0000000",
      name: "Scout",
      template: "general",
      soul: "",
      ownerName: "Ana",
      lessons: [
        { text: "Invoices go to finance", by: "Ana" },
        { text: "Always cite the source", by: null },
      ],
    });

    expect(soul).toContain(
      "\n\n## Lessons from the team\n- Invoices go to finance (taught by Ana)\n- Always cite the source",
    );
    expect(soul).not.toContain("Always cite the source (");
  });

  it("a retry turn replies in the given thread, skips taught knowledge and sends no reactions", async () => {
    const { ana, chat, scout } = await room();
    const ctxs: TurnContext[] = [];
    addTurnHooks({ name: "probe", onTurnStart: (c) => void ctxs.push(c) });
    await ana.engine.sendText(chat, "thread root");
    const root = await sent(ana, "thread root");

    await ana.engine.sendText(chat, "@Scout normal question");
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(1);
    const ok = await w.host.runProactive?.({
      agentId: scout.id,
      chatId: chat,
      prompt: "Answer again without private notes",
      kind: "retry",
      replyTo: root.id,
      noTaught: true,
    });

    expect(ok).toBe(true);
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(2);
    const reply = textsFrom(ana, scout.device_id)[1]!;
    expect(replyToOf(reply)).toBe(root.id);
    expect(metaOf(reply)?.trigger).toBe("retry");
    expect(ctxs.map((c) => [c.trigger, c.noTaught])).toEqual([
      ["mention", false],
      ["retry", true],
    ]);
    expect(ctxs[1]?.replyTo).toBe(root.id);
    expect(ctxs[1]?.prompt).toContain("Answer again without private notes");
    expect(reactionLog(ana, scout.device_id, root.id)).toEqual([]);
  }, 30000);
});
