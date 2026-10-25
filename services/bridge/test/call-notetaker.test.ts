import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@sa/protocol";
import { jwtVerify } from "jose";
import { afterEach, expect, it } from "vitest";
import { subscribe } from "../src/approvals/events.js";
import { Notetakers } from "../src/calls/notetaker.js";
import { NotesScheduler } from "../src/calls/scheduler.js";
import { callsBase, LK_SECRET, MEETING_TOKEN, NOTES_MD, sleep, waitFor } from "./call-fixture.js";

const CALL = "call0001";
const NT = "nt000001";
const START = Date.UTC(2026, 9, 25, 10, 0, 0);

type Base = Awaited<ReturnType<typeof callsBase>>;
let b: Base;
let pidDir = "";
afterEach(async () => {
  rmSync(pidDir, { recursive: true, force: true });
  await b.db.close();
});

/** Call `call0001` in c1 started at START; ana (inviter) and bob accepted, dan joined and declined. */
async function seed(segments: Array<{ user: string; at: number; text: string }>) {
  b = await callsBase();
  pidDir = mkdtempSync(join(tmpdir(), "sa-pids-"));
  const { db } = b;
  await db.query(
    "insert into sa.calls (id, chat_id, room, started_by, started_at, anchor_message_id) values ($1,'c1',$2,'ana',to_timestamp($3 / 1000.0),'anchor-msg-01')",
    [CALL, `call-${CALL}`, START],
  );
  for (const u of ["ana", "bob", "dan"])
    await db.query("insert into sa.call_participants (call_id, user_id) values ($1,$2)", [CALL, u]);
  await db.query(
    "insert into sa.call_notetakers (id, call_id, agent_id, invited_by, status, worker) values ($1,$2,'scribe','ana','active','starting')",
    [NT, CALL],
  );
  for (const [u, d] of [
    ["ana", "accepted"],
    ["bob", "accepted"],
    ["dan", "declined"],
  ])
    await db.query(
      "insert into sa.call_consents (notetaker_id, user_id, decision) values ($1,$2,$3)",
      [NT, u, d],
    );
  for (const s of segments) await addSegment(s.user, s.at, s.text);
}
const addSegment = (user: string, at: number, text: string) =>
  b.db.query(
    "insert into sa.call_segments (notetaker_id, speaker_user_id, t0, t1, text) values ($1,$2,to_timestamp($3 / 1000.0),to_timestamp($4 / 1000.0),$5)",
    [NT, user, START + at, START + at + 2000, text],
  );
const noteRows = () =>
  b.db.query<{
    id: string;
    version: number;
    final: boolean;
    body_md: string;
    action_items: unknown;
  }>(
    "select id, version, final, body_md, action_items from sa.call_notes where notetaker_id = $1 order by version",
    [NT],
  );

class FakeSpawner {
  spawned: Array<{
    cmd: string;
    args: string[];
    opts: { env: Record<string, string>; stdin: string };
  }> = [];
  exits: Array<(code: number | null) => void> = [];
  killed: string[] = [];
  spawn(cmd: string, args: string[], opts: { env: Record<string, string>; stdin: string }) {
    this.spawned.push({ cmd, args, opts });
    return {
      pid: 4242,
      onExit: (cb: (code: number | null) => void) => {
        this.exits.push(cb);
      },
      kill: (sig?: string) => {
        this.killed.push(sig ?? "SIGTERM");
      },
    };
  }
}

const ENV = {
  SA_NOTETAKER: "worker",
  LIVEKIT_URL: "ws://127.0.0.1:7880",
  LIVEKIT_API_SECRET: LK_SECRET,
  MEETING_TOKEN,
  AUDIO_URL: "http://127.0.0.1:8645",
  AUDIO_TOKEN: "audio-secret-9",
  SA_BRIDGE_URL: "http://127.0.0.1:8644",
};

function fakeClock() {
  let fn: (() => void | Promise<void>) | null = null;
  return {
    now: () => START + 600_000,
    setInterval: (f: () => void | Promise<void>, _ms: number) => {
      fn = f;
      return () => {
        fn = null;
      };
    },
    tick: async () => {
      await fn?.();
    },
  };
}

it("the worker gets its token, meeting token, audio token and media key only on stdin, never in argv or env; no spawn without a call server", async () => {
  await seed([]);
  const sp = new FakeSpawner();
  const nts = new Notetakers({
    db: b.db,
    spawner: sp,
    livekitAvailable: async () => true,
    log: () => {},
    onFinal: () => {},
    pidDir,
    env: ENV,
  });
  await nts.start(CALL, NT, "MEDIAKEY-abc123");

  expect(sp.spawned).toHaveLength(1);
  const { cmd, args, opts } = sp.spawned[0] ?? { cmd: "", args: [], opts: { env: {}, stdin: "" } };
  expect(cmd).toBe("uv");
  expect(args).toContain("sa-meeting");
  expect(args).toContain("join");
  expect(opts.env).toMatchObject({
    SA_BRIDGE_URL: "http://127.0.0.1:8644",
    SA_NOTETAKER_ID: NT,
    LIVEKIT_URL: "ws://127.0.0.1:7880",
    AUDIO_URL: "http://127.0.0.1:8645",
    SA_STT_LANGUAGE: "en",
  });

  expect(opts.stdin.trimEnd().split("\n")).toHaveLength(1);
  const secrets = JSON.parse(opts.stdin);
  expect(secrets).toMatchObject({
    meeting_token: MEETING_TOKEN,
    audio_token: "audio-secret-9",
    media_key: "MEDIAKEY-abc123",
  });
  const lk = (await jwtVerify(secrets.lk_token, new TextEncoder().encode(LK_SECRET))).payload as {
    sub: string;
    video: Record<string, unknown>;
  };
  expect(lk.sub).toBe("agent:scribe");
  expect(lk.video).toMatchObject({ room: `call-${CALL}`, canPublish: false });

  const outside = JSON.stringify([cmd, args, opts.env]);
  const leaked = [
    secrets.lk_token,
    MEETING_TOKEN,
    "audio-secret-9",
    "MEDIAKEY-abc123",
    LK_SECRET,
  ].filter((secret) => outside.includes(secret));
  expect(leaked).toEqual([]);
  expect(readFileSync(join(pidDir, `${NT}.pid`), "utf8").trim()).toBe("4242");

  const down = new FakeSpawner();
  const off = new Notetakers({
    db: b.db,
    spawner: down,
    livekitAvailable: async () => false,
    log: () => {},
    onFinal: () => {},
    pidDir,
    env: ENV,
  });
  await expect(off.start(CALL, NT)).rejects.toThrow(/livekit_unavailable/);
  expect(down.spawned).toHaveLength(0);
});

it("a worker crash, a stop and a call end racing produce exactly one final summary and mark the notetaker failed", async () => {
  await seed([
    { user: "ana", at: 5000, text: "hello team" },
    { user: "bob", at: 9000, text: "ship on Friday" },
  ]);
  const finals: unknown[] = [];
  const sched = new NotesScheduler({
    db: b.db,
    agentHost: b.host,
    intervalMs: 300_000,
    clock: fakeClock(),
    onFinalNotes: async (n: unknown) => {
      finals.push(n);
    },
    log: () => {},
  });
  const sp = new FakeSpawner();
  const nts = new Notetakers({
    db: b.db,
    spawner: sp,
    livekitAvailable: async () => true,
    log: () => {},
    onFinal: (id: string) => sched.final(id),
    pidDir,
    env: ENV,
  });
  await nts.start(CALL, NT);

  sp.exits[0]?.(1); // worker exits with code 1 while active
  await Promise.all([sched.final(NT), sched.final(NT)]); // stop and end land at the same time
  await waitFor(async () => {
    const [n] = await b.db.query<{ status: string; worker: string }>(
      "select status, worker from sa.call_notetakers where id = $1",
      [NT],
    );
    return n?.status === "failed" && n.worker === "error";
  });
  await sleep(100);

  const rows = await noteRows();
  expect(rows.filter((r) => r.final)).toHaveLength(1);
  expect(rows).toHaveLength(1);
  expect(b.completes).toHaveLength(1);
  expect(finals).toHaveLength(1);
});

it("interim notes come only when new segments arrived and go only to the inviter; a failing model still yields fallback notes", async () => {
  await seed([
    { user: "ana", at: 5000, text: "hello team" },
    { user: "bob", at: 9000, text: "ship on Friday" },
  ]);
  const got = new Map<string, ServerEvent[]>();
  const unsub = ["ana", "bob", "dan"].map((u) => {
    got.set(u, []);
    return subscribe(u, (e) => got.get(u)?.push(e));
  });
  try {
    const clock = fakeClock();
    const finals: Array<{ version: number; final: boolean }> = [];
    const sched = new NotesScheduler({
      db: b.db,
      agentHost: b.host,
      intervalMs: 300_000,
      clock,
      onFinalNotes: async (n: { version: number; final: boolean }) => {
        finals.push(n);
      },
      log: () => {},
    });
    sched.start();

    await clock.tick();
    await waitFor(async () => (await noteRows()).length === 1);
    const first = (await noteRows())[0];
    expect(first).toMatchObject({ version: 1, final: false });
    expect(first?.body_md).toContain("**Call notes** · Project");
    expect(first?.body_md).toContain("Speakers: Ana, Bob");
    expect(first?.body_md).toContain("Not captured: 1 person who did not consent");
    expect(first?.body_md).toContain(NOTES_MD);
    expect(first?.action_items).toEqual([{ owner: "Ana", text: "send the draft", due: "Monday" }]);
    expect(b.completes[0]?.agentId).toBe("scribe");
    expect(b.completes[0]?.sessionKey).toBe(`call-notes:${NT}`);
    const prompt = b.completes[0]?.messages[1]?.content ?? "";
    expect(prompt).toContain("[00:05] Ana: hello team");
    expect(prompt).toContain("[00:09] Bob: ship on Friday");
    expect(prompt).not.toContain("Dan");

    await clock.tick(); // nothing new since version 1
    await sleep(50);
    expect(b.completes).toHaveLength(1);
    expect(await noteRows()).toHaveLength(1);

    await addSegment("bob", 20_000, "one more thing");
    await clock.tick();
    await waitFor(async () => (await noteRows()).length === 2);
    expect((await noteRows())[1]).toMatchObject({ version: 2, final: false });
    expect(finals).toEqual([]); // interim notes are not offered for publication

    b.state.complete = async () => {
      throw new Error("model is down");
    };
    await sched.final(NT);
    const last = (await noteRows())[2];
    expect(last).toMatchObject({ version: 3, final: true });
    expect(last?.body_md).toContain("The summary could not be generated on this Mac");
    expect(last?.body_md).toContain("> [00:20] Bob: one more thing");
    expect(last?.body_md).not.toContain("Dan");
    expect(finals).toMatchObject([{ version: 3, final: true }]);

    const notesEvents = (u: string) => got.get(u)?.filter((e) => e.type === "call.notes");
    expect(notesEvents("ana")).toEqual([
      { type: "call.notes", call_id: CALL, version: 1, final: false },
      { type: "call.notes", call_id: CALL, version: 2, final: false },
      { type: "call.notes", call_id: CALL, version: 3, final: true },
    ]);
    expect(notesEvents("bob")).toEqual([]);
    expect(notesEvents("dan")).toEqual([]);
  } finally {
    for (const u of unsub) u();
  }
});

it("a transcript over 14 000 characters is summarised in parts and then merged once", async () => {
  await seed(
    Array.from({ length: 20 }, (_, i) => ({
      user: "ana",
      at: 5000 + i * 1000,
      text: "w".repeat(1000),
    })),
  );
  b.state.complete = async (m) =>
    (m[1]?.content ?? "").startsWith("Below are notes") ? NOTES_MD : "PART-NOTES";
  const sched = new NotesScheduler({
    db: b.db,
    agentHost: b.host,
    intervalMs: 300_000,
    clock: fakeClock(),
    onFinalNotes: async () => {},
    log: () => {},
  });
  await sched.final(NT);

  const user = b.completes.map((c) => c.messages[1]?.content ?? "");
  expect(user).toHaveLength(3);
  expect(user.filter((c) => c.includes("This is part 1 of 2 of one call."))).toHaveLength(1);
  expect(user.filter((c) => c.includes("This is part 2 of 2 of one call."))).toHaveLength(1);
  expect(user[2]).toMatch(/^Below are notes for consecutive parts of one call\./);
  expect(user[2]).toContain("### Part 1\nPART-NOTES");
  expect(user[2]).toContain("### Part 2\nPART-NOTES");
  const rows = await noteRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.final).toBe(true);
  expect(rows[0]?.body_md).toContain(NOTES_MD);
  expect(rows[0]?.body_md).not.toContain("PART-NOTES");
});
