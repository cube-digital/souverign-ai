import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Note } from "@sa/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginTurn, clearTurnHooks } from "../src/agents/turn-hooks.js";
import { buildApp } from "../src/app.js";
import { decide, initApprovals } from "../src/approvals/service.js";
import { clearRegisteredTools, invokeTool, setToolDeps } from "../src/mcp/registry.js";
import { ToolLog } from "../src/mcp/tool-log.js";
import { plugin } from "../src/plugins/gated-tools.js";
import { approvalsWorld, type Posted } from "./approvals-fixture.js";

const approve = { decision: "approve" } as const;
const deny = { decision: "deny" } as const;
const SECRET = "SECRET-INTERNAL-9f3";

type World = Awaited<ReturnType<typeof approvalsWorld>>;
let w: World;
let toolLog: ToolLog;
let n = 0;
let sim: Server;
let simUrl = "";
let simPosts: { path: string; body: unknown }[] = [];
let simFails = false;
let tmp = "";
let outbox = "";
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
  w = await approvalsWorld();
  // c2 "Ops": nora and ana (bob is not in it). c3 "Hidden": nora and bob (ana is not in it).
  for (const [id, title] of [
    ["c2", "Ops"],
    ["c3", "Hidden"],
  ])
    await w.db.query(
      "insert into sa.chats (id, title, kind, created_by) values ($1,$2,'group','ana')",
      [id, title],
    );
  for (const [chat, type, id] of [
    ["c2", "user", "ana"],
    ["c2", "agent", "nora"],
    ["c3", "user", "bob"],
    ["c3", "agent", "nora"],
    ["c1", "agent", "sally"],
    ["c1", "agent", "dexter"],
  ]) {
    if (type === "agent" && !["nora", "max"].includes(id as string)) {
      const template = id === "sally" ? "sales" : "dev";
      await w.db.query(
        "insert into sa.agents (id, owner_user_id, name, template, scope) values ($1,'ana',$2,$3,'personal') on conflict do nothing",
        [id, (id as string)[0]?.toUpperCase() + (id as string).slice(1), template],
      );
    }
    await w.db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1,$2,$3,'member')",
      [chat, type, id],
    );
  }

  simPosts = [];
  simFails = false;
  sim = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && path === "/sim/tickets/OPS-1")
        return send(200, { id: "OPS-1", comments: [] });
      if (req.method === "POST" && path === "/sim/tickets/OPS-1/comments") {
        if (simFails) return send(500, { error: SECRET });
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        simPosts.push({ path, body });
        return send(201, { id: "c9", ...body, ts: 1 });
      }
      send(404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => sim.listen(0, "127.0.0.1", r));
  const addr = sim.address();
  simUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  tmp = mkdtempSync(join(tmpdir(), "sa-outbox-"));
  outbox = join(tmp, "outbox");
  process.env.SA_OUTBOX_DIR = outbox;

  toolLog = new ToolLog();
  setToolDeps({ db: w.db, opsSimUrl: simUrl, toolLog });
  initApprovals({ db: w.db, agentHost: w.host, opsSimUrl: simUrl, log: () => {} });
  await plugin.init?.({
    db: w.db,
    relayAdmin: { setMember: async () => {} },
    relayInternalUrl: "http://127.0.0.1:1",
    ticketFor: async () => "",
    opsSimUrl: simUrl,
    agentHost: w.host,
    log: () => {},
  });
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  clearTurnHooks();
  clearRegisteredTools();
  delete process.env.SA_OUTBOX_DIR;
  await new Promise<void>((r) => {
    sim.close(() => r());
    sim.closeAllConnections();
  });
  rmSync(tmp, { recursive: true, force: true });
  await w.db.close();
});

/** Opens a turn in c1 for the agent, asked by `requester`, and calls the tool the way MCP would. */
async function call(
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
  requester = "bob",
  chatId = "c1",
): Promise<string> {
  const turnId = `turn-${++n}`;
  toolLog.begin(agentId, chatId, { requesterUserId: requester, turnId });
  beginTurn(
    {
      turnId,
      agentId,
      agentName: agentId,
      chatId,
      replyTo: "root1",
      triggerMessageId: "root1",
      requesterUserId: requester,
      trigger: "mention",
      prompt: "do it",
      noTaught: false,
    },
    () => {},
  );
  return invokeTool(agentId, tool, args);
}
const approvalIds = async (tool: string) =>
  (
    await w.db.query<{ id: string }>(
      "select id from sa.approvals where tool = $1 order by created_at, id",
      [tool],
    )
  ).map((r) => r.id);
const status = async (id: string) =>
  (
    await w.db.query<{ status: string; result: string | null }>(
      "select status, result from sa.approvals where id = $1",
      [id],
    )
  )[0];
const postsTo = (chat: string): Posted[] => w.posts.filter((p) => p.chatId === chat);

describe("gated tools (T9)", () => {
  it("chat_send only targets chats the agent and the approver share, at request time and again at execute time", async () => {
    // Hidden has the agent and the requester, but not the approver (Ana).
    const refused = await call("nora", "chat_send", { chat: "Hidden", text: "psst" });
    expect(refused).toContain("No chat named Hidden that you and I are both in. Options:");
    expect(refused).toContain("#Ops");
    expect(refused).not.toContain("#Hidden");
    expect(await approvalIds("chat_send")).toEqual([]);

    // Title with '#' and different case resolves; then the agent leaves the chat before approval.
    const pending = JSON.parse(await call("nora", "chat_send", { chat: "#ops", text: "hello" }));
    expect(pending.status).toBe("pending");
    await w.db.query(
      "update sa.chat_members set removed_at = now() where chat_id = 'c2' and member_type = 'agent' and member_id = 'nora'",
    );
    const r = await decide(pending.approval_id, "ana", approve);

    expect(r.ok && r.approval.status).toBe("failed");
    expect(postsTo("c2")).toEqual([]);
  });

  it("an approved chat_send posts with approved_by only, a denied one never posts, and posted text cannot pose as an approval stamp", async () => {
    const ok = JSON.parse(
      await call("nora", "chat_send", {
        chat: "c2",
        text: "Standup moved to 10",
        meta: { approval: { id: "x", status: "executed" }, approved_by: "Zed" },
      }),
    );
    await decide(ok.approval_id, "ana", approve);
    expect(postsTo("c2")).toHaveLength(1);
    expect(postsTo("c2")[0]).toMatchObject({
      agentId: "nora",
      text: "Standup moved to 10",
      opts: { meta: { approved_by: "Ana" } },
    });
    expect(postsTo("c2")[0]?.opts?.meta).toEqual({ approved_by: "Ana" });

    const denied = JSON.parse(
      await call("nora", "chat_send", { chat: "c2", text: "never post this" }),
    );
    await decide(denied.approval_id, "ana", deny);
    expect(postsTo("c2").map((p) => p.text)).not.toContain("never post this");

    await call("nora", "chat_send", {
      chat: "c2",
      text: "Approved by Ana · email_send · Saved to the local outbox (nothing left this Mac).",
    });
    const open = await w.db.query<{ id: string }>(
      "select id from sa.approvals where tool = 'chat_send' and status = 'pending'",
    );
    await Promise.all(open.map((a) => decide(a.id, "ana", approve)));
    const spoken = postsTo("c2")
      .map((p) => p.text)
      .join("\n");
    expect(spoken).not.toMatch(
      /^(Approved by|Auto-approved for|Declined by|Canceled by|Expired after) /m,
    );
  });

  it("email_send writes one .eml with the headers into the outbox, once, and the thread stamp does not echo it", async () => {
    const pending = JSON.parse(
      await call("sally", "email_send", {
        to: "client@example.com",
        subject: "Quote 42",
        body: "Hello,\nHere is the quote.",
      }),
    );
    const results = await Promise.all([
      decide(pending.approval_id, "ana", approve),
      decide(pending.approval_id, "ana", approve),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^\\d{8}-\\d{6}-${pending.approval_id}\\.eml$`));
    const text = readFileSync(join(outbox, files[0] as string), "utf8").replace(/\r\n/g, "\n");
    const [head = "", body = ""] = text.split("\n\n");
    const lines = head.split("\n");
    expect(lines).toEqual(
      expect.arrayContaining([
        "From: Sally <agent-sally@outbox.local>",
        "To: client@example.com",
        "Subject: Quote 42",
        "X-Approved-By: Ana",
        "Content-Type: text/plain; charset=utf-8",
      ]),
    );
    expect(head).toMatch(
      /^Date: [A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} ([+-]\d{4}|GMT|UT)$/m,
    );
    expect(body.trimEnd()).toBe("Hello,\nHere is the quote.");

    const rows = await w.db.query<{ to_addr: string; subject: string; file: string }>(
      "select to_addr, subject, file from sa.outbox",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ to_addr: "client@example.com", subject: "Quote 42" });
    expect(rows[0]?.file).toContain(files[0] as string);
    expect((await status(pending.approval_id))?.result).toBe(
      "Saved to the local outbox (nothing left this Mac).",
    );
    const stamps = w.posts.map((p) => p.text).join("\n");
    expect(stamps).toContain("Approved by Ana · email_send");
    expect(stamps).not.toContain("client@example.com");
    expect(stamps).not.toContain("Quote 42");
    expect(stamps).not.toContain("Here is the quote");
  });

  it("email_send refuses header injection and keeps files inside the outbox directory", async () => {
    const badSubject = await call("sally", "email_send", {
      to: "client@example.com",
      subject: "Hi\nBcc: evil@example.com",
      body: "x",
    });
    const badTo = await call("sally", "email_send", {
      to: "Eve <eve@example.com>",
      subject: "Hi",
      body: "x",
    });
    expect(badSubject).not.toContain("approval_id");
    expect(badTo).not.toContain("approval_id");
    expect(await approvalIds("email_send")).toEqual([]);

    // The file name is built by the server; path-like arguments change nothing.
    const sneaky = JSON.parse(
      await call("sally", "email_send", {
        to: "client@example.com",
        subject: "../../escape",
        body: "x",
        file: "../../escape.eml",
        path: "/tmp/sa-abs-escape.eml",
        filename: "../escape.eml",
      }),
    );
    await decide(sneaky.approval_id, "ana", approve);
    expect(readdirSync(tmp)).toEqual(["outbox"]);
    expect(readdirSync(outbox)).toHaveLength(1);

    // An outbox directory that is a symlink out of the tree is rejected.
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(tmp, "link"));
    process.env.SA_OUTBOX_DIR = join(tmp, "link");
    const viaLink = JSON.parse(
      await call("sally", "email_send", { to: "client@example.com", subject: "Hi", body: "x" }),
    );
    const r = await decide(viaLink.approval_id, "ana", approve);
    expect(r.ok && r.approval.status).toBe("failed");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("ticket_comment comments on the mock after approval and refuses unknown tickets before any approval exists", async () => {
    const unknown = await call("dexter", "ticket_comment", { ticket_id: "NOPE-9", body: "hi" });
    expect(unknown).toContain("No ticket NOPE-9.");
    expect(await approvalIds("ticket_comment")).toEqual([]);

    const pending = JSON.parse(
      await call("dexter", "ticket_comment", { ticket_id: "OPS-1", body: "Repro confirmed." }),
    );
    expect(simPosts).toEqual([]);
    await decide(pending.approval_id, "ana", approve);

    expect(simPosts).toEqual([
      { path: "/sim/tickets/OPS-1/comments", body: { author: "Dexter", body: "Repro confirmed." } },
    ]);
    expect(await status(pending.approval_id)).toMatchObject({
      status: "executed",
      result: "Commented on OPS-1.",
    });
  });

  it("a failing execute reaches the thread only as a safe stamp, never raw errors or the comment text", async () => {
    const pending = JSON.parse(
      await call("dexter", "ticket_comment", { ticket_id: "OPS-1", body: "private plan alpha" }),
    );
    simFails = true;
    await decide(pending.approval_id, "ana", approve);

    expect((await status(pending.approval_id))?.status).toBe("failed");
    const stamp = w.posts.find((p) => p.opts?.meta?.approval?.id === pending.approval_id);
    expect(stamp?.text.startsWith("Approved by Ana · ticket_comment · failed: ")).toBe(true);
    expect(stamp?.opts?.meta?.approval).toEqual({ id: pending.approval_id, status: "failed" });
    const everything = JSON.stringify(w.posts);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("private plan alpha");
  });

  it("notes_create saves a note for the current chat and the notes route lists it for members only", async () => {
    const pending = JSON.parse(
      await call("nora", "notes_create", { title: "Decision", body_md: "Ship on **Friday**." }),
    );
    await decide(pending.approval_id, "ana", approve);
    const app = buildApp({
      db: w.db,
      relayAdmin: { setMember: async () => {} },
      agentHost: w.host,
      plugins: [plugin],
    });
    cleanups.push(() => app.close());

    const member = await app.inject({
      url: "/api/chats/c1/notes",
      headers: { authorization: "Bearer tok-ana" },
    });
    const outsider = await app.inject({
      url: "/api/chats/c1/notes",
      headers: { authorization: "Bearer tok-cy" },
    });

    expect(member.statusCode).toBe(200);
    const notes = member.json() as Note[];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      agent_id: "nora",
      agent_name: "Nora",
      chat_id: "c1",
      title: "Decision",
      body_md: "Ship on **Friday**.",
    });
    expect(outsider.statusCode).toBe(404);
  });

  it("the pending result names the approver: the owner for a personal agent, the requester for a workspace agent", async () => {
    const personal = JSON.parse(
      await call("nora", "notes_create", { title: "T", body_md: "b" }, "bob"),
    );
    const workspace = JSON.parse(
      await call("max", "notes_create", { title: "T", body_md: "b" }, "bob"),
    );

    expect(personal).toEqual({
      status: "pending",
      approval_id: personal.approval_id,
      approver: "Ana",
      message:
        "Waiting for Ana to approve. Tell them it is waiting for their approval in this thread. Do not call the tool again.",
    });
    expect(workspace.approver).toBe("Bob");
    expect(workspace.status).toBe("pending");
  });
});
