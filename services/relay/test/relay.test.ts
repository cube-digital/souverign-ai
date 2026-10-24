import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cryptoReady,
  deviceIdFor,
  encrypt,
  messageAad,
  newChatKey,
  newDeviceKeys,
  randomId,
} from "@sa/crypto";
import type { Envelope, RelayOp, RelayRecentRow } from "@sa/protocol";
import { signTicket } from "@sa/protocol/ticket";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createRelay } from "../src/server.js";

const ADMIN = "test-admin-token";

let dir: string;
let relay: Awaited<ReturnType<typeof createRelay>> | undefined;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  await cryptoReady();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sa-relay-"));
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await relay?.close();
  relay = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start() {
  relay = await createRelay({ dbPath: join(dir, "relay.sqlite"), adminToken: ADMIN });
  return relay;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  msgs: RelayOp[] = [];
  private constructor(
    readonly ws: WebSocket,
    readonly device: string,
  ) {
    ws.on("message", (d) => this.msgs.push(JSON.parse(d.toString()) as RelayOp));
  }
  static async connect(url: string, device = deviceIdFor(newDeviceKeys().publicKey)) {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/relay/ws`, { maxPayload: 32 << 20 });
    sockets.push(ws);
    const c = new Client(ws, device);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    c.send({ op: "hello", device_id: device, ticket: signTicket(ADMIN, device, 60_000).ticket });
    await c.next((m) => m.op === "ready");
    return c;
  }
  send(op: unknown) {
    this.ws.send(JSON.stringify(op));
  }
  async next(pred: (m: RelayOp) => boolean, from = 0): Promise<RelayOp> {
    for (let i = 0; i < 100; i++) {
      const hit = this.msgs.slice(from).find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    throw new Error(`timeout; got ${JSON.stringify(this.msgs.slice(from))}`);
  }
  /** Send an op and return everything received until the matching terminal reply. */
  async ask(op: unknown, terminal: (m: RelayOp) => boolean): Promise<RelayOp[]> {
    const from = this.msgs.length;
    this.send(op);
    await this.next(terminal, from);
    return this.msgs.slice(from);
  }
  delivered(): string[] {
    return this.msgs.flatMap((m) => (m.op === "deliver" ? [m.env.id] : []));
  }
}

async function member(url: string, chat: string, device: string, op: "add" | "remove") {
  return fetch(`${url}/relay/admin/members`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, device_id: device, op }),
  });
}

function env(chat: string, sender: string, over: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    id: randomId(),
    chat_id: chat,
    sender_device: sender,
    epoch: 1,
    kind: "msg",
    nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ciphertext: "Y2lwaGVydGV4dC1ieXRlcw",
    ts: 1_700_000_000_000,
    ...over,
  } as Envelope;
}

async function recent(url: string): Promise<RelayRecentRow[]> {
  const r = await fetch(`${url}/relay/debug/recent?limit=50`, {
    headers: { authorization: `Bearer ${signTicket(ADMIN, "debug-viewer", 60_000).ticket}` },
  });
  return (await r.json()) as RelayRecentRow[];
}

describe("relay", () => {
  it("lets only active members send, sync and use blobs; non-members are refused and nothing is stored", async () => {
    const { url } = await start();
    const chat = randomId();
    const alice = await Client.connect(url);
    const mallory = await Client.connect(url);

    const unauth = await fetch(`${url}/relay/admin/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, device_id: alice.device, op: "add" }),
    });
    expect(unauth.status).toBe(401);
    expect((await member(url, chat, alice.device, "add")).ok).toBe(true);

    const bad = env(chat, mallory.device);
    const sendReply = await mallory.ask({ op: "send", env: bad }, (m) => m.op === "error");
    expect(sendReply).toEqual([
      { op: "error", code: "not_member", message: expect.any(String), ref: bad.id },
    ]);
    expect(await recent(url)).toEqual([]);
    expect(alice.delivered()).toEqual([]);

    const syncReply = await mallory.ask(
      { op: "sync", chat_id: chat, since: 0 },
      (m) => m.op === "error",
    );
    expect(syncReply[0]).toMatchObject({ op: "error", code: "not_member" });

    const putBad = await mallory.ask(
      { op: "blob_put", id: "blob-mallory", chat_id: chat, data: "AAEC" },
      (m) => m.op === "error",
    );
    expect(putBad[0]).toMatchObject({ op: "error", code: "not_member" });

    const putOk = await alice.ask(
      { op: "blob_put", id: "blob-alice-1", chat_id: chat, data: "AAEC" },
      (m) => m.op === "blob_ok" || m.op === "error",
    );
    expect(putOk).toEqual([{ op: "blob_ok", id: "blob-alice-1" }]);
    const getBad = await mallory.ask(
      { op: "blob_get", id: "blob-alice-1" },
      (m) => m.op === "error",
    );
    expect(getBad.at(-1)).toMatchObject({ op: "error", code: "not_member" });
    const getOk = await alice.ask({ op: "blob_get", id: "blob-alice-1" }, (m) => m.op === "blob");
    expect(getOk).toEqual([{ op: "blob", id: "blob-alice-1", data: "AAEC" }]);
  });

  it("delivers a msg to every member socket and a key only to its to_device", async () => {
    const { url } = await start();
    const chat = randomId();
    const a = await Client.connect(url);
    const b = await Client.connect(url);
    const c = await Client.connect(url);
    for (const d of [a, b, c]) await member(url, chat, d.device, "add");

    const m1 = env(chat, a.device);
    a.send({ op: "send", env: m1 });
    await Promise.all(
      [a, b, c].map((x) => x.next((m) => m.op === "deliver" && m.env.id === m1.id)),
    );

    const key = env(chat, a.device, { kind: "key", to_device: b.device });
    a.send({ op: "send", env: key });
    await b.next((m) => m.op === "deliver" && m.env.id === key.id);

    const m2 = env(chat, a.device);
    a.send({ op: "send", env: m2 });
    await Promise.all(
      [a, b, c].map((x) => x.next((m) => m.op === "deliver" && m.env.id === m2.id)),
    );

    expect(a.delivered()).toEqual([m1.id, m2.id]);
    expect(b.delivered()).toEqual([m1.id, key.id, m2.id]);
    expect(c.delivered()).toEqual([m1.id, m2.id]);
  });

  it("shows a device nothing from before it was added or after it was removed", async () => {
    const { url } = await start();
    const chat = randomId();
    const a = await Client.connect(url);
    const b = await Client.connect(url);
    await member(url, chat, a.device, "add");

    const m1 = env(chat, a.device);
    await a.ask({ op: "send", env: m1 }, (m) => m.op === "ack");

    await member(url, chat, b.device, "add");
    const m2 = env(chat, a.device);
    await a.ask({ op: "send", env: m2 }, (m) => m.op === "ack");

    const sync = await b.ask({ op: "sync", chat_id: chat, since: 0 }, (m) => m.op === "synced");
    expect(sync.flatMap((m) => (m.op === "deliver" ? [m.env.id] : []))).toEqual([m2.id]);

    const removal = await member(url, chat, b.device, "remove");
    expect(removal.ok).toBe(true);
    // removing a device that is no longer (or never was) a member is idempotent
    expect((await member(url, chat, b.device, "remove")).ok).toBe(true);
    expect((await member(url, chat, randomId(), "remove")).ok).toBe(true);

    const seen = b.delivered().length;
    const m3 = env(chat, a.device);
    await a.ask({ op: "send", env: m3 }, (m) => m.op === "ack");
    await sleep(150);
    expect(b.delivered().length).toBe(seen);
    expect(b.delivered()).not.toContain(m3.id);

    const afterSend = env(chat, b.device);
    const reply = await b.ask({ op: "send", env: afterSend }, (m) => m.op === "error");
    expect(reply[0]).toMatchObject({ op: "error", code: "not_member", ref: afterSend.id });
  });

  it("never stores message plaintext in the database or its wal/shm files", async () => {
    const { url, close } = await start();
    const chat = randomId();
    const a = await Client.connect(url);
    await member(url, chat, a.device, "add");

    const sentinels = [
      "zanzibarquartz",
      "ogrelantern",
      "pumiceviolin",
      "tundramarmot",
      "velcroheron",
    ];
    const key = newChatKey();
    for (const word of sentinels) {
      const id = randomId();
      const { nonce, ciphertext } = encrypt(
        key,
        JSON.stringify({ type: "text", text: `hello ${word} world` }),
        messageAad(chat, 1, id),
      );
      const e = env(chat, a.device, { id, nonce, ciphertext });
      await a.ask({ op: "send", env: e }, (m) => m.op === "ack");
    }
    const rows = await recent(url);
    expect(rows).toHaveLength(5);

    await close();
    relay = undefined;
    const bytes = Buffer.concat(readdirSync(dir).map((f) => readFileSync(join(dir, f))));
    expect(bytes.length).toBeGreaterThan(0);
    const prefix = rows[0]?.ciphertext_prefix;
    expect(prefix).toBeDefined();
    expect(bytes.includes(Buffer.from(prefix ?? "", "utf8"))).toBe(true);
    expect(sentinels.filter((w) => bytes.includes(Buffer.from(w, "utf8")))).toEqual([]);
  });

  it("accepts a hello only with a valid, unexpired ticket for that same device", async () => {
    const { url } = await start();
    const deviceA = deviceIdFor(newDeviceKeys().publicKey);
    const deviceB = deviceIdFor(newDeviceKeys().publicKey);
    const attempts = [
      signTicket("some-other-secret", deviceA, 60_000).ticket, // forged
      signTicket(ADMIN, deviceA, 60_000, Date.now() - 120_000).ticket, // expired
      signTicket(ADMIN, deviceA, 60_000).ticket, // device A's ticket used as device B
    ];
    const outcomes: { msgs: RelayOp[]; closed: boolean }[] = [];
    for (const ticket of attempts) {
      const ws = new WebSocket(`${url.replace(/^http/, "ws")}/relay/ws`);
      sockets.push(ws);
      const msgs: RelayOp[] = [];
      ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as RelayOp));
      const closed = new Promise<boolean>((res) => ws.once("close", () => res(true)));
      await new Promise((res, rej) => {
        ws.once("open", res);
        ws.once("error", rej);
      });
      ws.send(JSON.stringify({ op: "hello", device_id: deviceB, ticket }));
      outcomes.push({
        msgs,
        closed: await Promise.race([closed, sleep(1500).then(() => false)]),
      });
    }
    expect(outcomes).toEqual(
      attempts.map(() => ({
        msgs: [{ op: "error", code: "bad_ticket", message: expect.any(String) }],
        closed: true,
      })),
    );
  });

  it("requires a ticket on the debug view", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/relay/debug/recent`)).status).toBe(401);
    const forged = signTicket("some-other-secret", "dev", 60_000).ticket;
    expect(
      (await fetch(`${url}/relay/debug/recent`, { headers: { authorization: `Bearer ${forged}` } }))
        .status,
    ).toBe(401);
    const ok = await fetch(`${url}/relay/debug/recent`, {
      headers: { authorization: `Bearer ${signTicket(ADMIN, "dev", 60_000).ticket}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([]);
  });

  it("answers a failing operation with bad_request and keeps the socket open", async () => {
    const { url } = await start();
    const chat = randomId();
    const a = await Client.connect(url);
    await member(url, chat, a.device, "add");
    // fault injection at the storage boundary: the next statement run throws
    const stmtProto = Object.getPrototypeOf(new Database(":memory:").prepare("select 1"));
    const run = vi.spyOn(stmtProto, "run").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });
    const put = { op: "blob_put", id: "blob-fail", chat_id: chat, data: "AAEC" };
    const reply = await a.ask(put, (m) => m.op === "error" || m.op === "blob_ok");
    run.mockRestore();
    expect(reply).toEqual([
      { op: "error", code: "bad_request", message: expect.any(String), ref: "blob-fail" },
    ]);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    const good = env(chat, a.device);
    const ack = await a.ask({ op: "send", env: good }, (m) => m.op === "ack");
    expect(ack.at(-1)).toMatchObject({ op: "ack" });
  });
});
