import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { initApprovals, registerGatedTool, requestApproval } from "../src/approvals/service.js";
import { plugin } from "../src/plugins/approvals.js";
import { approvalsWorld } from "./approvals-fixture.js";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of closers.splice(0)) await c();
});

async function setup() {
  const w = await approvalsWorld();
  initApprovals({ db: w.db, agentHost: w.host, opsSimUrl: "http://127.0.0.1:1", log: () => {} });
  const app = buildApp({
    db: w.db,
    relayAdmin: { setMember: async () => {} },
    agentHost: w.host,
    plugins: [plugin],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  closers.push(() => app.close());
  registerGatedTool("sse_probe", {
    executor: {
      editable: [],
      alwaysAllowed: false,
      stamp: false,
      validate: async (a) => a,
      preview: () => ({ title: "SECRET-TITLE", target: "t", fields: [], leaves_chat: false }),
      execute: async () => "ok",
    },
  });
  return { ...w, base };
}

/** Opens the stream and returns a reader that accumulates text until a predicate holds. */
async function open(base: string, user: string) {
  const ctl = new AbortController();
  closers.push(() => ctl.abort());
  const res = await fetch(`${base}/api/events`, {
    headers: { authorization: `Bearer tok-${user}` },
    signal: ctl.signal,
  });
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const until = async (has: (s: string) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!has(buf) && Date.now() < end) {
      const chunk = await Promise.race([
        reader?.read(),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 100)),
      ]);
      if (chunk && !chunk.done) buf += dec.decode(chunk.value);
    }
    return buf;
  };
  return { res, until, text: () => buf };
}

const events = (s: string) =>
  s
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)) as { type: string; [k: string]: any });

describe("GET /api/events (T8)", () => {
  it("the approver's stream gets hello then the full approval event", async () => {
    const w = await setup();
    const s = await open(w.base, "ana");
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get("content-type")).toContain("text/event-stream");
    await s.until((t) => t.includes('"hello"'));
    const g = await requestApproval({
      agentId: "nora",
      chatId: "c1",
      replyTo: null,
      turnId: null,
      requesterUserId: "bob",
      kind: "tool",
      tool: "sse_probe",
      args: { secret: "PAYLOAD" },
    });
    const text = await s.until((t) => t.includes('"approval"'));
    const [hello, approval] = events(text);
    expect(hello).toEqual({ type: "hello", user_id: "ana" });
    expect(approval?.type).toBe("approval");
    expect(approval?.approval).toMatchObject({
      tool: "sse_probe",
      status: "pending",
      args: { secret: "PAYLOAD" },
      preview: { title: "SECRET-TITLE" },
      approver_user_id: "ana",
    });
    expect(g.status).toBe("pending");
  });

  it("another chat member's stream gets only approval_public, without args or preview", async () => {
    const w = await setup();
    const s = await open(w.base, "bob");
    await s.until((t) => t.includes('"hello"'));
    await requestApproval({
      agentId: "nora",
      chatId: "c1",
      replyTo: null,
      turnId: null,
      requesterUserId: "bob",
      kind: "tool",
      tool: "sse_probe",
      args: { secret: "PAYLOAD" },
    });
    const text = await s.until((t) => t.includes("approval_public"));
    const got = events(text);
    expect(got.map((e) => e.type)).toEqual(["hello", "approval_public"]);
    expect(got[1]?.approval).toMatchObject({
      tool: "sse_probe",
      status: "pending",
      approver_name: "Ana",
    });
    expect(text).not.toContain("PAYLOAD");
    expect(text).not.toContain("SECRET-TITLE");
    expect(Object.keys(got[1]?.approval ?? {})).not.toContain("args");
    expect(Object.keys(got[1]?.approval ?? {})).not.toContain("preview");
  });

  it("a user outside the chat receives no event for it", async () => {
    const w = await setup();
    const s = await open(w.base, "cy");
    await s.until((t) => t.includes('"hello"'));
    await requestApproval({
      agentId: "nora",
      chatId: "c1",
      replyTo: null,
      turnId: null,
      requesterUserId: "bob",
      kind: "tool",
      tool: "sse_probe",
      args: { secret: "PAYLOAD" },
    });
    const text = await s.until((t) => t.includes("approval"), 600);
    expect(events(text)).toEqual([{ type: "hello", user_id: "cy" }]);
  });

  it("rejects a request without a valid session with 401", async () => {
    const w = await setup();
    const none = await fetch(`${w.base}/api/events`);
    const bad = await fetch(`${w.base}/api/events`, { headers: { authorization: "Bearer nope" } });
    expect([none.status, bad.status]).toEqual([401, 401]);
  });

  it("sends a ping comment within 15 s of silence so the web does not reconnect", async () => {
    const w = await setup();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const s = await open(w.base, "ana");
    await s.until((t) => t.includes('"hello"'));
    expect(s.text()).not.toContain(": ping");
    await vi.advanceTimersByTimeAsync(15_000);
    const text = await s.until((t) => t.includes(": ping\n\n"));
    expect(text).toContain(": ping\n\n");
  });
});
