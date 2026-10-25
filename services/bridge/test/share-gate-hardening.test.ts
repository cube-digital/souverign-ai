import { afterEach, describe, expect, it } from "vitest";
import {
  addTurnHooks,
  beginTurn,
  clearTurnHooks,
  endTurn,
  FAIL_CLOSED_NOTICE,
  runBeforeReply,
  type TurnContext,
} from "../src/agents/turn-hooks.js";
import { cancel, decide } from "../src/approvals/service.js";
import { beforeReply } from "../src/approvals/share-gate.js";
import { invokeTool } from "../src/mcp/registry.js";
import { loadScopeInput } from "../src/memory/scope-input.js";
import { recallScopes } from "../src/memory/scopes.js";
import { addRecalls, clearRecalls } from "../src/memory/turn-recalls.js";
import { DOC_TEXT, gateWorld, RECALL_DIRECTIVE } from "./share-gate-fixture.js";
import {
  addPersonalAgent,
  metaOf,
  reactionsNet,
  rekey,
  sent,
  sleep,
  textOf,
  textsFrom,
} from "./teammates-fixture.js";

type G = Awaited<ReturnType<typeof gateWorld>>;
let g: G | undefined;
afterEach(async () => {
  await g?.close();
  g = undefined;
});

/** Nora (owned by ana) in Project with `ask` and a document taught by ana. */
async function askSetup() {
  g = await gateWorld();
  const nora = await addPersonalAgent(g.w, g.ana, g.chat, "Nora");
  await rekey(g.w, g.chat, g.ana, [g.ana, g.bob], [nora]);
  await g.teach(nora.id, "itemA", "ana");
  await g.setShare(nora.id, "ask");
  return { g, nora };
}

const taughtHit = (agentId: string) => ({
  text: DOC_TEXT,
  score: 1,
  space: `agent:${agentId}`,
  kind: "knowledge" as const,
  origin_chat_id: null,
  source: { type: "doc", id: "itemA", title: "contract.pdf", ts: 1 },
  chunk_idx: 0,
});

/** Opens a turn (as the host does) that has already recalled taught knowledge. */
function taughtTurn(s: { g: G; nora: { id: string } }, turnId: string): TurnContext {
  const ctx: TurnContext = {
    turnId,
    agentId: s.nora.id,
    agentName: "Nora",
    chatId: s.g.chat,
    replyTo: null,
    triggerMessageId: null,
    requesterUserId: "bob",
    trigger: "mention",
    prompt: "notice period?",
    noTaught: false,
  };
  beginTurn(ctx, () => {});
  s.g.w.toolLog.begin(s.nora.id, s.g.chat, { requesterUserId: "bob", turnId });
  addRecalls(turnId, [taughtHit(s.nora.id)]);
  return ctx;
}
const closeTurn = (s: { g: G; nora: { id: string } }, turnId: string) => {
  s.g.w.toolLog.end(s.nora.id);
  endTurn(s.nora.id, () => {});
  clearRecalls(turnId);
};

describe("D-9 ask share gate hardening", () => {
  it("1: ask_user and memory_remember refuse after a taught recall in a shared chat with ask", async () => {
    const s = await askSetup();
    taughtTurn(s, "t-tools");

    const asked = await invokeTool(s.nora.id, "ask_user", { question: `Is it ${DOC_TEXT}?` });
    const saved = await invokeTool(s.nora.id, "memory_remember", { text: DOC_TEXT });

    expect(asked).toMatch(/^I can't ask questions in this turn/);
    expect(saved).toMatch(/^I can't save notes in this turn/);
    expect(await s.g.w.db.query("select id from sa.questions")).toEqual([]);
    const items = await s.g.w.db.query<{ id: string }>("select id from sa.knowledge_items");
    expect(items.map((r) => r.id)).toEqual(["itemA"]);
    await sleep(300);
    expect(JSON.stringify(s.g.bob.seen.map((m) => m.body))).not.toContain("47 days");

    await s.g.setShare(s.nora.id, "always");
    expect(await invokeTool(s.nora.id, "memory_remember", { text: DOC_TEXT })).toMatch(
      /^Remembered\./,
    );
    closeTurn(s, "t-tools");
  }, 30000);

  it("2: Approve posts only the text and the preview's sources, never the trace", async () => {
    const s = await askSetup();
    await s.g.ana.engine.sendText(s.g.chat, `@Nora ${RECALL_DIRECTIVE}`);
    await expect.poll(() => textsFrom(s.g.bob, s.nora.device_id).length, { timeout: 8000 }).toBe(1);
    const [row] = await s.g.w.db.query<{ id: string; preview: { sources: unknown[] } }>(
      "select id, preview from sa.approvals",
    );

    await decide(row?.id ?? "", "ana", { decision: "approve" });

    await expect.poll(() => textsFrom(s.g.bob, s.nora.device_id).length, { timeout: 8000 }).toBe(2);
    const meta = metaOf(textsFrom(s.g.bob, s.nora.device_id)[1]!);
    expect(Object.keys(meta ?? {}).sort()).toEqual(["approved_by", "citations"]);
    expect(meta?.citations).toEqual(row?.preview.sources);
    expect(JSON.stringify(meta)).not.toContain("memory_recall");
  }, 30000);

  it("3: without the share gate hook, ask reads no taught knowledge", async () => {
    const s = await askSetup();
    const taughtScopes = async () => {
      const inp = await loadScopeInput(s.g.w.db, s.nora.id, s.g.chat, {
        noTaught: false,
        requesterUserId: "bob",
      });
      return recallScopes(inp!).filter((x) => x.origin_chat_ids?.[0] === null);
    };

    expect(await taughtScopes()).toHaveLength(1);
    clearTurnHooks();
    expect(await taughtScopes()).toEqual([]);
  }, 30000);

  it("4: the gate fails closed when the approver is not an active member of the chat", async () => {
    const s = await askSetup();
    await s.g.w.db.query(
      "update sa.chat_members set removed_at = now() where chat_id = $1 and member_id = 'ana'",
      [s.g.chat],
    );
    const ctx = taughtTurn(s, "t-approver");

    await expect(beforeReply(ctx, { text: DOC_TEXT, meta: {} })).rejects.toThrow(/share gate/);
    expect(await s.g.approvals()).toEqual([]);
    closeTurn(s, "t-approver");
  }, 30000);

  it("5: execute rechecks the policy; failed and canceled previews post a status line and lose their text", async () => {
    const s = await askSetup();
    const seen = () => textsFrom(s.g.bob, s.nora.device_id).map(textOf);
    await s.g.bob.engine.sendText(s.g.chat, `@Nora ${RECALL_DIRECTIVE}`);
    await expect.poll(() => seen().length, { timeout: 8000 }).toBe(1);
    await s.g.setShare(s.nora.id, "never");

    const [first] = await s.g.approvals();
    await decide(first?.id ?? "", "ana", { decision: "approve" });

    await expect.poll(() => seen().length, { timeout: 8000 }).toBe(2);
    expect(seen()[1]).toBe(
      "Approved by Ana · share_answer · failed: Sharing taught knowledge is off for this agent.",
    );
    expect((await s.g.approvals())[0]?.status).toBe("failed");

    await s.g.setShare(s.nora.id, "ask");
    await s.g.bob.engine.sendText(s.g.chat, `@Nora ${RECALL_DIRECTIVE}`);
    await expect.poll(() => seen().length, { timeout: 8000 }).toBe(3);
    const second = (await s.g.approvals())[1];
    expect((await cancel(second?.id ?? "", "bob")).ok).toBe(true);

    await expect.poll(() => seen().length, { timeout: 8000 }).toBe(4);
    expect(seen()[3]).toBe("Canceled by Bob · share_answer");
    await expect
      .poll(async () => {
        const [r] = await s.g.w.db.query<{ args: unknown; preview: { fields: unknown[] } }>(
          "select args, preview from sa.approvals where id = $1",
          [second?.id],
        );
        return [r?.args, r?.preview.fields, JSON.stringify(r).includes("47 days")];
      })
      .toEqual([{ question: expect.any(String) }, [], false]);
    expect(seen().some((t) => t.includes("47 days"))).toBe(false);
  }, 40000);

  it("6: notices carry sanitized meta only, and a share gate failure ends the turn with a warning", async () => {
    clearTurnHooks();
    addTurnHooks({
      name: "hold",
      beforeReply: async () => ({ action: "hold", notice: "wait", meta: { held: "h1" } }),
    });
    const draftMeta = {
      model: "m",
      trace: [{ kind: "thinking" as const, text: "secret" }],
      citations: [],
      recalls: ["secret"],
      draft: "secret",
    };
    const ctx = { ...({} as TurnContext), turnId: "t6", agentId: "a", chatId: "c" };
    const out = await runBeforeReply(ctx, { text: "secret", meta: draftMeta as never }, () => {});
    expect(out.text).toBe("wait");
    expect(JSON.stringify(out.meta)).toBe(JSON.stringify({ model: "m", held: "h1" }));
    expect(Object.keys(out.meta)).toEqual(expect.arrayContaining(["trace", "citations", "draft"]));
    clearTurnHooks();

    const s = await askSetup();
    await s.g.w.db.query("alter table sa.approvals rename to approvals_gone");
    const prompt = `@Nora ${RECALL_DIRECTIVE}`;
    await s.g.ana.engine.sendText(s.g.chat, prompt);
    const trigger = await sent(s.g.ana, prompt);

    await expect
      .poll(() => reactionsNet(s.g.ana, s.nora.device_id, trigger.id), { timeout: 8000 })
      .toEqual(["⚠️"]);
    const notice = textsFrom(s.g.ana, s.nora.device_id)[0]!;
    expect(textOf(notice)).toBe(FAIL_CLOSED_NOTICE);
    expect(metaOf(notice)?.trace).toBeUndefined();
    expect(metaOf(notice)?.citations).toBeUndefined();
  }, 30000);
});
