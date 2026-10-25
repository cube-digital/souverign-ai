import { afterEach, describe, expect, it } from "vitest";
import { beginTurn, endTurn } from "../src/agents/turn-hooks.js";
import { notesCreate } from "../src/approvals/executors.js";
import { registerGatedTool, requestApproval } from "../src/approvals/service.js";
import { watchPendingShares } from "../src/approvals/share-gate.js";
import { failInterrupted, insertGrant } from "../src/approvals/store.js";
import { invokeTool } from "../src/mcp/registry.js";
import { registerForgetTool } from "../src/memory/forget.js";
import { addRecalls, recallsFor } from "../src/memory/turn-recalls.js";
import { DOC_TEXT, gateWorld, RECALL_DIRECTIVE } from "./share-gate-fixture.js";
import { addPersonalAgent, rekey, sleep, textOf, textsFrom } from "./teammates-fixture.js";

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

/** Opens a turn as the host does; `taught` marks it as having recalled taught knowledge. */
function openTurn(
  s: { g: G; nora: { id: string } },
  turnId: string,
  requester: string,
  taught = false,
) {
  beginTurn(
    {
      turnId,
      agentId: s.nora.id,
      agentName: "Nora",
      chatId: s.g.chat,
      replyTo: null,
      triggerMessageId: null,
      requesterUserId: requester,
      trigger: "mention",
      prompt: "p",
      noTaught: false,
    },
    () => {},
  );
  s.g.w.toolLog.begin(s.nora.id, s.g.chat, { requesterUserId: requester, turnId });
  if (taught) {
    addRecalls(turnId, [
      {
        text: DOC_TEXT,
        score: 1,
        space: `agent:${s.nora.id}`,
        kind: "knowledge",
        origin_chat_id: null,
        source: { type: "doc", id: "itemA", title: "contract.pdf", ts: 1 },
        chunk_idx: 0,
      },
    ]);
  }
  return () => {
    s.g.w.toolLog.end(s.nora.id);
    endTurn(s.nora.id, () => {});
  };
}

describe("share gate bypasses", () => {
  it("memory_forget searches no taught knowledge under ask in a shared chat, and records what it read", async () => {
    const s = await askSetup();
    registerForgetTool();
    let close = openTurn(s, "t-forget-ask", "bob");

    const asked = await invokeTool(s.nora.id, "memory_forget", { about: "termination notice" });

    expect(asked).toBe("Nothing I know here matches that.");
    expect(recallsFor("t-forget-ask")).toEqual([]);
    close();

    await s.g.setShare(s.nora.id, "always");
    close = openTurn(s, "t-forget-always", "bob");
    await invokeTool(s.nora.id, "memory_forget", { about: "termination notice" });
    expect(recallsFor("t-forget-always").map((r) => r.hit.source.id)).toEqual(["itemA"]);
    close();
  }, 30000);

  it("a grant does not auto-approve a gated tool in a turn the share gate would hold", async () => {
    const s = await askSetup();
    registerGatedTool("notes_create", { executor: notesCreate });
    await insertGrant(s.g.w.db, "ana", s.nora.id, "notes_create");
    const req = (turnId: string) =>
      requestApproval({
        agentId: s.nora.id,
        chatId: s.g.chat,
        replyTo: null,
        turnId,
        requesterUserId: "ana",
        kind: "tool",
        tool: "notes_create",
        args: { title: "Notice", body_md: DOC_TEXT },
      });

    let close = openTurn(s, "t-held", "ana", true);
    const held = await req("t-held");
    close();
    close = openTurn(s, "t-plain", "ana");
    const plain = await req("t-plain");
    close();

    expect(held.status).toBe("pending");
    expect(plain.status).toBe("executed");
  }, 30000);

  it("share rows keep only citations, and an answer that failed while down gets its status line and loses its text", async () => {
    const s = await askSetup();
    await s.g.bob.engine.sendText(s.g.chat, `@Nora ${RECALL_DIRECTIVE}`);
    await expect.poll(() => textsFrom(s.g.bob, s.nora.device_id).length, { timeout: 8000 }).toBe(1);
    const [row] = await s.g.w.db.query<{ id: string; args: { meta: object } }>(
      "select id, args from sa.approvals",
    );
    expect(Object.keys(row?.args.meta ?? {})).toEqual(["citations"]);

    // approved, then the bridge went down before posting
    await s.g.w.db.query(
      "update sa.approvals set status = 'approved', decided_by = 'ana', decided_at = now() where id = $1",
      [row?.id],
    );
    await failInterrupted(s.g.w.db);
    await watchPendingShares(s.g.w.db);

    await expect.poll(() => textsFrom(s.g.bob, s.nora.device_id).length, { timeout: 8000 }).toBe(2);
    await sleep(1000); // the posted line settles in the host before the world closes
    expect(textOf(textsFrom(s.g.bob, s.nora.device_id)[1]!)).toBe(
      "Approved by Ana · share_answer · The bridge restarted before this ran.",
    );
    const [after] = await s.g.w.db.query<{ args: object }>(
      "select args from sa.approvals where id = $1",
      [row?.id],
    );
    expect(Object.keys(after?.args ?? {})).toEqual(["question"]);
  }, 30000);
});
