import type { Approval } from "@sa/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArgsError,
  cancel,
  DEFAULT_APPROVAL_TTL_MS,
  decide,
  type Executor,
  type GateResult,
  gatedTool,
  initApprovals,
  registerGatedTool,
  requestApproval,
  startSweeper,
} from "../src/approvals/service.js";
import { approvalsWorld, sleep } from "./approvals-fixture.js";

let seq = 0;
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  delete process.env.SA_APPROVAL_TTL_MS;
});

/** A notes_create-like tool: editable text, grants allowed. Names are unique per test. */
function tool(over: Partial<Executor> & { defaultTtlMs?: number; slowMs?: number } = {}) {
  const name = `fake_tool_${++seq}`;
  const executed: Record<string, unknown>[] = [];
  const denied: Approval[] = [];
  const executor: Executor = {
    editable: ["text"],
    alwaysAllowed: true,
    stamp: true,
    validate: async (args) => {
      if (typeof args.text !== "string") throw new ArgsError("text is required");
      return args;
    },
    preview: (args, info) => ({
      title: "Save note",
      target: info.chatTitle,
      fields: [
        { key: "text", label: "Text", value: String(args.text), editable: true, multiline: true },
      ],
      leaves_chat: false,
    }),
    execute: async (args) => {
      if (over.slowMs) await sleep(over.slowMs);
      executed.push(args);
      return `saved: ${String(args.text)}`;
    },
    onDenied: async (a) => {
      denied.push(a);
    },
    ...over,
  };
  registerGatedTool(name, {
    executor,
    ...(over.defaultTtlMs ? { defaultTtlMs: over.defaultTtlMs } : {}),
  });
  return { name, executed, denied };
}

const req = (
  t: string,
  over: Partial<Parameters<typeof requestApproval>[0]> = {},
): Parameters<typeof requestApproval>[0] => ({
  agentId: "nora",
  chatId: "c1",
  replyTo: "root1",
  turnId: "turn1",
  requesterUserId: "bob",
  kind: "tool",
  tool: t,
  args: { text: "hello" },
  ...over,
});

const pending = (r: GateResult): Approval => {
  if (r.status === "error") throw new Error(`gate error: ${r.error} ${r.message}`);
  return r.approval;
};
const row = async (db: Awaited<ReturnType<typeof approvalsWorld>>["db"], id: string) =>
  (
    await db.query<{
      status: string;
      result: string | null;
      auto: boolean;
      decided_by: string | null;
    }>("select status, result, auto, decided_by from sa.approvals where id = $1", [id])
  )[0];
const approve = { decision: "approve" } as const;

async function setup() {
  const w = await approvalsWorld();
  initApprovals({ db: w.db, agentHost: w.host, opsSimUrl: "http://127.0.0.1:1", log: () => {} });
  return w;
}

describe("approvals service (T8)", () => {
  it("routes the card to the owner of a personal agent and to the requester of a workspace agent", async () => {
    await setup();
    const t = tool();
    const personal = await requestApproval(
      req(t.name, { agentId: "nora", requesterUserId: "bob" }),
    );
    const workspace = await requestApproval(
      req(t.name, { agentId: "max", requesterUserId: "bob" }),
    );
    const none = await requestApproval(req(t.name, { agentId: "max", requesterUserId: null }));
    expect(pending(personal).approver_user_id).toBe("ana");
    expect(pending(personal).status).toBe("pending");
    expect(pending(workspace).approver_user_id).toBe("bob");
    expect(none).toMatchObject({ status: "error", error: "no_approver" });
  });

  it("approve executes once, stores the result and posts the stamp in the thread", async () => {
    const w = await setup();
    const t = tool();
    const a = pending(await requestApproval(req(t.name)));
    const r = await decide(a.id, "ana", approve);
    expect(r.ok && r.approval.status).toBe("executed");
    expect(t.executed).toEqual([{ text: "hello" }]);
    expect(await row(w.db, a.id)).toMatchObject({
      status: "executed",
      result: "saved: hello",
      decided_by: "ana",
      auto: false,
    });
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]?.agentId).toBe("nora");
    expect(w.posts[0]?.chatId).toBe("c1");
    expect(w.posts[0]?.text.startsWith(`Approved by Ana · ${t.name}`)).toBe(true);
    expect(w.posts[0]?.opts?.replyTo).toBe("root1");
    expect(w.posts[0]?.opts?.meta?.approval?.id).toBe(a.id);
  });

  it("two concurrent approves execute once and the loser gets already_decided", async () => {
    const w = await setup();
    const t = tool({ slowMs: 60 });
    const a = pending(await requestApproval(req(t.name)));
    const results = await Promise.all([decide(a.id, "ana", approve), decide(a.id, "ana", approve)]);
    expect(results.map((r) => (r.ok ? "ok" : r.code)).sort()).toEqual(["already_decided", "ok"]);
    expect(t.executed).toHaveLength(1);
    expect((await row(w.db, a.id))?.status).toBe("executed");
  });

  it("a user who is not the approver cannot decide: not_found, still pending, nothing runs", async () => {
    const w = await setup();
    const t = tool();
    const a = pending(await requestApproval(req(t.name)));
    const byRequester = await decide(a.id, "bob", approve);
    const byOutsider = await decide(a.id, "cy", { decision: "deny" });
    expect(byRequester).toMatchObject({ ok: false, code: "not_found" });
    expect(byOutsider).toMatchObject({ ok: false, code: "not_found" });
    expect((await row(w.db, a.id))?.status).toBe("pending");
    expect(t.executed).toHaveLength(0);
    expect(t.denied).toHaveLength(0);
  });

  it("an approval past its expiry answers expired and never runs; the sweeper expires it with a stamp", async () => {
    const w = await setup();
    const t = tool();
    const a = pending(await requestApproval(req(t.name, { ttlMs: 50 })));
    await sleep(120);
    const late = await decide(a.id, "ana", approve);
    expect(late).toMatchObject({ ok: false, code: "expired" });
    expect(t.executed).toHaveLength(0);
    stops.push(startSweeper(20));
    await sleep(250);
    expect((await row(w.db, a.id))?.status).toBe("expired");
    expect(t.executed).toHaveLength(0);
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]?.text.startsWith("Expired after ")).toBe(true);
    expect(w.posts[0]?.text.endsWith(`without a decision · ${t.name}`)).toBe(true);
    expect(w.posts[0]?.opts?.replyTo).toBe("root1");
  });

  it("deny ends denied, runs onDenied, never executes and posts the Declined stamp", async () => {
    const w = await setup();
    const t = tool();
    const a = pending(await requestApproval(req(t.name)));
    const r = await decide(a.id, "ana", { decision: "deny" });
    expect(r.ok && r.approval.status).toBe("denied");
    expect(t.executed).toHaveLength(0);
    expect(t.denied.map((d) => d.id)).toEqual([a.id]);
    expect((await row(w.db, a.id))?.status).toBe("denied");
    expect(w.posts.map((p) => p.text)).toEqual([`Declined by Ana · ${t.name}`]);
  });

  it("edits may only change editable keys; an edit of text runs with the edited text", async () => {
    const w = await setup();
    const t = tool();
    const a = pending(await requestApproval(req(t.name)));
    const bad = await decide(a.id, "ana", { decision: "approve", args: { channel: "other" } });
    expect(bad).toMatchObject({ ok: false, code: "invalid_args" });
    expect((await row(w.db, a.id))?.status).toBe("pending");
    expect(t.executed).toHaveLength(0);
    const good = await decide(a.id, "ana", { decision: "approve", args: { text: "edited" } });
    expect(good.ok && good.approval.status).toBe("executed");
    expect(t.executed).toEqual([{ text: "edited" }]);
  });

  it("always creates a grant for allowed tools and the next request auto-executes; other tools get none", async () => {
    const w = await setup();
    const allowed = tool();
    const locked = tool({ alwaysAllowed: false });
    const a = pending(await requestApproval(req(allowed.name)));
    await decide(a.id, "ana", { decision: "approve", always: true });
    const next = await requestApproval(req(allowed.name, { args: { text: "again" } }));
    expect(next.status).toBe("executed");
    const auto = pending(next);
    expect(await row(w.db, auto.id)).toMatchObject({
      status: "executed",
      auto: true,
      decided_by: "ana",
    });
    expect(allowed.executed).toEqual([{ text: "hello" }, { text: "again" }]);

    const l = pending(await requestApproval(req(locked.name)));
    await decide(l.id, "ana", { decision: "approve", always: true });
    const grants = await w.db.query<{ tool: string }>(
      "select tool from sa.approval_grants where user_id = 'ana'",
    );
    expect(grants.map((g) => g.tool)).toEqual([allowed.name]);
    const again = await requestApproval(req(locked.name));
    expect(again.status).toBe("pending");
  });

  it("refuses the 6th pending approval for the same agent and chat", async () => {
    await setup();
    const t = tool();
    const first = [];
    for (let i = 0; i < 5; i++) {
      first.push(await requestApproval(req(t.name, { args: { text: `n${i}` } })));
    }
    const sixth = await requestApproval(req(t.name, { args: { text: "n5" } }));
    expect(first.map((r) => r.status)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(sixth).toMatchObject({ status: "error", error: "too_many_pending" });
  });

  it("an approved row left at startup ends failed and is not executed", async () => {
    const w = await setup();
    const t = tool();
    await w.db.query(
      `insert into sa.approvals (id, agent_id, chat_id, kind, tool, args, preview, status, approver_user_id, decided_by, decided_at, expires_at)
       values ('stuck', 'nora', 'c1', 'tool', $1, '{"text":"x"}', '{}', 'approved', 'ana', 'ana', now(), now() + interval '1 hour')`,
      [t.name],
    );
    initApprovals({ db: w.db, agentHost: w.host, opsSimUrl: "http://127.0.0.1:1", log: () => {} });
    await sleep(50);
    expect(await row(w.db, "stuck")).toMatchObject({
      status: "failed",
      result: "The bridge restarted before this ran.",
    });
    expect(t.executed).toHaveLength(0);
  });

  it("expiry comes from the request ttlMs, else the tool default, else 12 h, else SA_APPROVAL_TTL_MS", async () => {
    await setup();
    const withDefault = tool({ defaultTtlMs: 3_600_000 });
    const plain = tool();
    const seconds = (a: Approval) => Math.round((a.expires_at - a.created_at) / 1000);
    const byTool = pending(await requestApproval(req(withDefault.name)));
    const byRequest = pending(await requestApproval(req(withDefault.name, { ttlMs: 300_000 })));
    const byDefault = pending(await requestApproval(req(plain.name)));
    process.env.SA_APPROVAL_TTL_MS = "60000";
    const byEnv = pending(await requestApproval(req(plain.name)));
    expect(DEFAULT_APPROVAL_TTL_MS).toBe(43_200_000);
    expect([seconds(byTool), seconds(byRequest), seconds(byDefault), seconds(byEnv)]).toEqual([
      3600, 300, 43_200, 60,
    ]);
  });

  it("the registry takes new tools at runtime with their own approver rule; bad, duplicate and unknown names are refused", async () => {
    await setup();
    const proto = tool();
    const executor = gatedTool(proto.name)?.executor as Executor;
    registerGatedTool("call_notes_publish", { executor, approverRule: async () => "cy" });
    registerGatedTool("rule_returns_null", { executor, approverRule: async () => null });
    expect(gatedTool("call_notes_publish")?.executor).toBe(executor);
    expect(() => registerGatedTool("call_notes_publish", { executor })).toThrow();
    expect(() => registerGatedTool("Bad-Name", { executor })).toThrow();
    const routed = await requestApproval(req("call_notes_publish"));
    const nobody = await requestApproval(req("rule_returns_null"));
    const unknown = await requestApproval(req("never_registered"));
    expect(pending(routed).approver_user_id).toBe("cy");
    expect(nobody).toMatchObject({ status: "error", error: "no_approver" });
    expect(unknown).toMatchObject({ status: "error", error: "unknown_tool" });
  });

  it("only the requester can cancel; Canceled stamp, no execution, onDenied only when the canceller is the approver", async () => {
    const w = await setup();
    const t = tool();
    const a = pending(
      await requestApproval(req(t.name, { agentId: "nora", requesterUserId: "bob" })),
    );
    const byApprover = await cancel(a.id, "ana");
    const byOutsider = await cancel(a.id, "cy");
    expect(byApprover).toMatchObject({ ok: false, code: "not_found" });
    expect(byOutsider).toMatchObject({ ok: false, code: "not_found" });
    const byRequester = await cancel(a.id, "bob");
    expect(byRequester.ok && byRequester.approval.status).toBe("canceled");
    expect(await row(w.db, a.id)).toMatchObject({ status: "canceled", decided_by: "bob" });
    expect(w.posts.map((p) => p.text)).toEqual([`Canceled by Bob · ${t.name}`]);
    expect(t.executed).toHaveLength(0);
    expect(t.denied).toHaveLength(0);

    const own = pending(
      await requestApproval(req(t.name, { agentId: "max", requesterUserId: "bob" })),
    );
    const byBoth = await cancel(own.id, "bob");
    expect(byBoth.ok && byBoth.approval.status).toBe("canceled");
    expect(t.denied.map((d) => d.id)).toEqual([own.id]);
    expect(t.executed).toHaveLength(0);
  });
});
