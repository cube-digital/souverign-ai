import type { Approval } from "@sa/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { clearTurnHooks, runBeforeReply, type TurnContext } from "../src/agents/turn-hooks.js";
import { buildApp } from "../src/app.js";
import {
  ArgsError,
  decide,
  type Executor,
  type GateRequest,
  type GateResult,
  MAX_AUTO_PER_HOUR,
  registerGatedTool,
  requestApproval,
} from "../src/approvals/service.js";
import { plugin } from "../src/plugins/approvals.js";
import { approvalsWorld } from "./approvals-fixture.js";

let seq = 0;
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

function tool(over: Partial<Executor> = {}) {
  const name = `fix_tool_${++seq}`;
  const executed: Record<string, unknown>[] = [];
  registerGatedTool(name, {
    executor: {
      editable: ["text"],
      alwaysAllowed: true,
      stamp: true,
      validate: async (a) => a,
      preview: (a) => ({
        title: "Save",
        target: "t",
        fields: [
          { key: "text", label: "Text", value: String(a.text), editable: true, multiline: false },
        ],
        leaves_chat: false,
      }),
      execute: async (a) => {
        executed.push(a);
        return `saved ${String(a.text)}`;
      },
      ...over,
    },
  });
  return { name, executed };
}

const req = (t: string, over: Partial<GateRequest> = {}): GateRequest => ({
  agentId: "nora",
  chatId: "c1",
  replyTo: "root1",
  turnId: null,
  requesterUserId: "bob",
  kind: "tool",
  tool: t,
  args: { text: "SECRET-ARGS" },
  ...over,
});
const pending = (r: GateResult): Approval => {
  if (r.status === "error") throw new Error(r.error);
  return r.approval;
};
const PUBLIC_KEYS = [
  "agent_name",
  "approver_name",
  "chat_id",
  "id",
  "requester_user_id",
  "status",
  "tool",
];

async function setup() {
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
  closers.push(() => app.close());
  const as = (u: string) => ({ authorization: `Bearer tok-${u}` });
  return { ...w, app, as };
}

describe("approvals fix round 1", () => {
  it("re-validates at execute time and keeps raw errors and results out of the thread stamp", async () => {
    const w = await setup();
    let allowed = true;
    const gate = tool({
      validate: async (a) => {
        if (!allowed) throw new ArgsError("Bob is no longer in the target chat.");
        return a;
      },
    });
    const a = pending(await requestApproval(req(gate.name)));
    allowed = false;
    const r = await decide(a.id, "ana", { decision: "approve" });
    expect(r.ok && r.approval.status).toBe("failed");
    expect(gate.executed).toHaveLength(0);

    const crash = tool({
      execute: async () => {
        throw new Error("connect ECONNREFUSED 10.1.2.3 SECRET-INTERNAL");
      },
    });
    await decide(pending(await requestApproval(req(crash.name))).id, "ana", {
      decision: "approve",
    });
    const ok = tool();
    await decide(pending(await requestApproval(req(ok.name))).id, "ana", { decision: "approve" });

    expect(w.posts.map((p) => p.text)).toEqual([
      `Approved by Ana · ${gate.name} · failed: Bob is no longer in the target chat.`,
      `Approved by Ana · ${crash.name} · failed: internal error`,
      `Approved by Ana · ${ok.name} · done`,
    ]);
  });

  it("a grant never auto-runs a proactive turn, and auto runs are capped per hour", async () => {
    const w = await setup();
    const t = tool();
    await w.db.query(
      "insert into sa.approval_grants (user_id, agent_id, tool) values ('ana', 'nora', $1)",
      [t.name],
    );
    const proactive = await requestApproval(req(t.name, { requesterUserId: null }));
    expect(proactive.status).toBe("pending");
    await decide(pending(proactive).id, "ana", { decision: "deny" });

    const statuses: string[] = [];
    for (let i = 0; i <= MAX_AUTO_PER_HOUR; i++) {
      statuses.push((await requestApproval(req(t.name, { args: { text: `n${i}` } }))).status);
    }
    expect(statuses.slice(0, MAX_AUTO_PER_HOUR).every((s) => s === "executed")).toBe(true);
    expect(statuses[MAX_AUTO_PER_HOUR]).toBe("pending");
    expect(t.executed).toHaveLength(MAX_AUTO_PER_HOUR);
  });

  it("an approver or requester who left the chat can no longer decide, list or cancel", async () => {
    const w = await setup();
    const t = tool();
    const a = pending(await requestApproval(req(t.name)));
    await w.db.query(
      "update sa.chat_members set removed_at = now() where chat_id = 'c1' and member_id in ('ana', 'bob')",
    );
    expect(await decide(a.id, "ana", { decision: "approve" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const list = await w.app.inject({ url: "/api/approvals?status=all", headers: w.as("ana") });
    expect(list.json()).toEqual([]);
    const cancel = await w.app.inject({
      method: "POST",
      url: `/api/approvals/${a.id}/cancel`,
      headers: w.as("bob"),
      payload: {},
    });
    expect(cancel.statusCode).toBe(404);
    expect(t.executed).toHaveLength(0);
  });

  it("drops meta.trace when the turn created an approval or the trace names a gated tool", async () => {
    await setup();
    const t = tool();
    const turn = (turnId: string): TurnContext => ({
      turnId,
      agentId: "nora",
      agentName: "Nora",
      chatId: "c1",
      replyTo: "root1",
      triggerMessageId: "root1",
      requesterUserId: "bob",
      trigger: "mention",
      prompt: "",
      noTaught: false,
    });
    const step = (name: string) => ({
      kind: "tool" as const,
      name,
      args: "SECRET-ARGS",
      result: "r",
      ms: 1,
    });
    const a = pending(await requestApproval(req(t.name, { turnId: "t-approval" })));
    const withApproval = await runBeforeReply(
      turn("t-approval"),
      { text: "ok", meta: { trace: [step("chat_read")] } },
      () => {},
    );
    const namesGated = await runBeforeReply(
      turn("t-none"),
      { text: "ok", meta: { trace: [step(t.name)] } },
      () => {},
    );
    const plain = await runBeforeReply(
      turn("t-plain"),
      { text: "ok", meta: { trace: [step("chat_read")] } },
      () => {},
    );
    expect(withApproval.meta.approvals).toEqual([a.id]);
    expect(withApproval.meta.trace).toBeUndefined();
    expect(namesGated.meta.trace).toBeUndefined();
    expect(plain.meta.trace).toHaveLength(1);
  });

  it("the requester's list returns only the public shape", async () => {
    const w = await setup();
    const t = tool();
    await requestApproval(req(t.name));
    const res = await w.app.inject({
      url: "/api/approvals?status=all&role=requester",
      headers: w.as("bob"),
    });
    const rows = res.json() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(PUBLIC_KEYS);
    expect(res.body).not.toContain("SECRET-ARGS");
  });

  it("a requester who is not the approver gets the public shape from cancel", async () => {
    const w = await setup();
    const t = tool();
    const a = pending(await requestApproval(req(t.name)));
    const res = await w.app.inject({
      method: "POST",
      url: `/api/approvals/${a.id}/cancel`,
      headers: w.as("bob"),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(PUBLIC_KEYS);
    expect(res.json()).toMatchObject({ status: "canceled" });
    expect(res.body).not.toContain("SECRET-ARGS");
  });
});
