import { afterEach, describe, expect, it } from "vitest";
import { FAIL_CLOSED_NOTICE } from "../src/agents/turn-hooks.js";
import { decide, startSweeper } from "../src/approvals/service.js";
import { DOC_TEXT, gateWorld, NO_HITS_REPLY, RECALL_DIRECTIVE } from "./share-gate-fixture.js";
import {
  addPersonalAgent,
  insertWorkspaceAgent,
  joinWorkspaceAgent,
  metaOf,
  rekey,
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
  return { g, nora, ana: g.ana, bob: g.bob, chat: g.chat };
}
const seenTexts = (s: { ana: G["ana"] }, deviceId: string) =>
  textsFrom(s.ana, deviceId).map(textOf);

describe("share gate (ask)", () => {
  it("approve posts the held answer with approved_by and its citations", async () => {
    const s = await askSetup();
    await s.ana.engine.sendText(s.chat, `@Nora ${RECALL_DIRECTIVE}`);
    await expect.poll(() => textsFrom(s.ana, s.nora.device_id).length, { timeout: 8000 }).toBe(1);
    const [row] = await s.g.approvals();
    expect(row).toMatchObject({ kind: "share", tool: "share_answer", status: "pending" });
    expect(row?.args.text).toContain("47 days");

    const res = await decide(row?.id ?? "", "ana", { decision: "approve" });

    expect(res.ok).toBe(true);
    await expect.poll(() => textsFrom(s.ana, s.nora.device_id).length, { timeout: 8000 }).toBe(2);
    const posted = textsFrom(s.ana, s.nora.device_id)[1]!;
    expect(textOf(posted)).toBe(row?.args.text);
    expect(["Ana", "ana"]).toContain(metaOf(posted)?.approved_by);
    expect(metaOf(posted)?.citations?.[0]).toMatchObject({
      source_id: "itemA",
      title: "contract.pdf",
      taught_by: "Ana",
    });
    expect((await s.g.approvals())[0]?.status).toBe("executed");
  }, 30000);

  it("deny re-answers without taught knowledge and the retry posts without a new approval", async () => {
    const s = await askSetup();
    await s.ana.engine.sendText(s.chat, `@Nora ${RECALL_DIRECTIVE}`);
    await expect.poll(() => textsFrom(s.ana, s.nora.device_id).length, { timeout: 8000 }).toBe(1);
    const [row] = await s.g.approvals();

    await decide(row?.id ?? "", "ana", { decision: "deny" });

    await expect
      .poll(() => seenTexts(s, s.nora.device_id).includes(NO_HITS_REPLY), { timeout: 8000 })
      .toBe(true);
    const retry = textsFrom(s.ana, s.nora.device_id).find((m) => textOf(m) === NO_HITS_REPLY)!;
    expect(metaOf(retry)?.held).toBeUndefined();
    expect(metaOf(retry)?.approvals).toBeUndefined();
    expect(seenTexts(s, s.nora.device_id).some((t) => t.includes("47 days"))).toBe(false);
    const rows = await s.g.approvals();
    expect(rows.map((r) => r.status)).toEqual(["denied"]);
  }, 30000);

  it("a workspace agent sends the private preview to the requester and the public notice names them", async () => {
    g = await gateWorld();
    const max = await insertWorkspaceAgent(g.w, {
      id: "ag-max",
      name: "Max",
      rosterId: "max",
      template: "general",
    });
    await joinWorkspaceAgent(g.w, g.chat, max);
    await rekey(g.w, g.chat, g.ana, [g.ana, g.bob], [max]);
    await g.teach(max.id, "itemW", "ana");
    await g.setShare(max.id, "ask");

    await g.bob.engine.sendText(g.chat, `@Max ${RECALL_DIRECTIVE}`);

    await expect.poll(() => textsFrom(g!.bob, max.device_id).length, { timeout: 8000 }).toBe(1);
    const [row] = await g.approvals();
    expect(row).toMatchObject({
      kind: "share",
      approver_user_id: "bob",
      requester_user_id: "bob",
      status: "pending",
    });
    expect(row?.preview.title).toBe("Post an answer that uses taught knowledge in #Project");
    const notice = textsFrom(g.bob, max.device_id)[0]!;
    expect(textOf(notice)).toBe(
      "Max prepared an answer that uses what Ana taught it. Waiting for Bob to approve.",
    );
    expect(metaOf(notice)?.held).toBe(row?.id);
  }, 30000);

  it("an expired preview never posts the answer and starts no retry", async () => {
    const s = await askSetup();
    await s.ana.engine.sendText(s.chat, `@Nora ${RECALL_DIRECTIVE}`);
    await expect.poll(() => textsFrom(s.ana, s.nora.device_id).length, { timeout: 8000 }).toBe(1);
    await s.g.w.db.query(
      "update sa.approvals set expires_at = now() - interval '1 minute' where status = 'pending'",
    );
    const stop = startSweeper(20);

    await expect
      .poll(async () => (await s.g.approvals())[0]?.status, { timeout: 5000 })
      .toBe("expired");
    await sleep(500);
    stop();

    const texts = seenTexts(s, s.nora.device_id);
    expect(texts.some((t) => t.includes("47 days"))).toBe(false);
    expect(texts).not.toContain(NO_HITS_REPLY);
    expect((await s.g.approvals()).map((r) => r.status)).toEqual(["expired"]);
  }, 30000);

  it("a DM with the owner never holds, even with ask", async () => {
    g = await gateWorld();
    const nora = await addPersonalAgent(g.w, g.ana, g.chat, "Nora");
    await g.teach(nora.id, "itemA", "ana");
    await g.setShare(nora.id, "ask");
    const dmRes = await g.w.app.inject({
      method: "POST",
      url: `/api/agents/${nora.id}/dm`,
      headers: { authorization: `Bearer ${g.ana.token}` },
    });
    const dm = dmRes.json() as { id: string; members: { devices: never[] }[] };
    await g.ana.engine.start([dm.id]);
    await g.ana.engine.createEpoch(
      dm.id,
      dm.members.flatMap((m) => m.devices),
    );

    await g.ana.engine.sendText(dm.id, RECALL_DIRECTIVE);

    await expect.poll(() => textsFrom(g!.ana, nora.device_id).length, { timeout: 8000 }).toBe(1);
    const reply = textsFrom(g.ana, nora.device_id)[0]!;
    expect(textOf(reply)).toContain(DOC_TEXT);
    expect(metaOf(reply)?.held).toBeUndefined();
    expect(await g.approvals()).toEqual([]);
  }, 30000);

  it("fails closed when the gate cannot create the approval: notice only, no answer text", async () => {
    const s = await askSetup();
    await s.g.w.db.query("alter table sa.approvals rename to approvals_gone");

    await s.ana.engine.sendText(s.chat, `@Nora ${RECALL_DIRECTIVE}`);

    await expect.poll(() => textsFrom(s.ana, s.nora.device_id).length, { timeout: 8000 }).toBe(1);
    await sleep(400);
    expect(seenTexts(s, s.nora.device_id)).toEqual([FAIL_CLOSED_NOTICE]);
    expect(JSON.stringify(s.bob.seen.map((m) => m.body))).not.toContain("47 days");
  }, 30000);
});
