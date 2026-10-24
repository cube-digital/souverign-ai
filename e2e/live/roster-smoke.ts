// Live smoke: @Ops and @QA tagged in one message both answer in its thread with real tool calls and
// receipts; Stop interrupts a live turn; vague questions still use tools (bug 4).
// Needs `make up` and `make dev` running, and the PIN of `ana` in .run/demo-pins.txt.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatEngine, type ChatMessage, MemoryKeyStore, RelayClient } from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import type { Chat, LoginResponse } from "@sa/protocol";

const BRIDGE = process.env.SA_BRIDGE_URL ?? "http://127.0.0.1:8647";
const RELAY_WS = process.env.SA_RELAY_URL ?? "ws://127.0.0.1:8648";
const QUESTION = "@Ops @QA is 7.4 ready to ship, and is the cluster healthy enough to roll it out?";
const OPS_TOOLS = ["cluster_health", "metric_trend", "db_sync_status"];
const QA_TOOLS = ["release_status", "test_runs"];
const WAIT_MS = 240_000;
const VAGUE_RUNS = 5;
const VAGUE_MIN_WITH_TOOLS = 4;

function pinOf(user: string): string {
  const file = join(import.meta.dirname, "..", "..", ".run", "demo-pins.txt");
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${user}:`));
  if (!line) throw new Error(`no PIN for ${user} in .run/demo-pins.txt`);
  return line.slice(user.length + 1).trim();
}

let token = "";
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${BRIDGE}/api${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

function fail(msg: string): never {
  console.error(`roster-smoke FAILED: ${msg}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secs = (from: number) => `${((Date.now() - from) / 1000).toFixed(1)}s`;

await cryptoReady();
const login = await api<LoginResponse>("/login", "POST", { user_id: "ana", pin: pinOf("ana") });
token = login.token;

// A Node device for Ana; the custodian grants it the seed rooms when it registers.
const keys = newDeviceKeys();
const deviceId = deviceIdFor(keys.publicKey);
await api("/devices", "POST", { device_id: deviceId, public_key: keys.publicKey });
const store = new MemoryKeyStore();
await store.putDevice({ deviceId, keys });
const client = new RelayClient({
  url: `${RELAY_WS.replace(/^http/, "ws").replace(/\/$/, "")}/relay/ws`,
  deviceId,
  getTicket: async () =>
    (await api<{ ticket: string }>("/relay-ticket", "POST", { device_id: deviceId })).ticket,
});
await client.connect();
const engine = new ChatEngine({ link: client, store, device: { deviceId, keys } });

const messages: ChatMessage[] = [];
const activity: { agentDevice: string; phase: string; turnId?: string; at: number }[] = [];
engine.onMessage((m) => messages.push(m));
engine.onActivity((a) => {
  const turnId = a.body.turn_id;
  activity.push({
    agentDevice: a.senderDevice,
    phase: a.body.phase,
    at: Date.now(),
    ...(turnId ? { turnId } : {}),
  });
});

async function until<T>(what: string, ms: number, probe: () => T | undefined): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = probe();
    if (v !== undefined) return v;
    await sleep(200);
  }
  return fail(`${what} within ${ms / 1000}s`);
}

// The room, and the chat key the custodian shares (rotated after the grant: wait until it settles).
let room: Chat | undefined;
for (let i = 0; i < 300 && !room; i++) {
  const chats = await api<Chat[]>("/chats");
  room = chats.find((c) => c.seed_key === "release-7.4");
  if (!room) await sleep(200);
}
if (!room) fail("the release-7.4 room is not visible to ana");
const roomId = room.id;
await engine.start([roomId]);
let lastEpoch = 0;
let stableSince = Date.now();
await until("a stable chat key for release-7.4", 60_000, () => {
  void engine.latestEpoch(roomId).then((e) => {
    if (e !== lastEpoch) {
      lastEpoch = e;
      stableSince = Date.now();
    }
  });
  return lastEpoch > 0 && Date.now() - stableSince > 3000 ? true : undefined;
});

const members = (await api<Chat[]>("/chats")).find((c) => c.id === roomId)?.members ?? [];
const agentDeviceOf = (name: string) =>
  members.find((x) => x.member_type === "agent" && x.display_name === name)?.devices[0]?.device_id;

type Text = Extract<NonNullable<ChatMessage["body"]>, { type: "text" }>;
async function ask(text: string): Promise<{ id: string; at: number }> {
  const seen = messages.length;
  const at = Date.now();
  await engine.sendText(roomId, text);
  const mine = await until("own message echoed", 15_000, () =>
    messages
      .slice(seen)
      .find((m) => m.senderDevice === deviceId && m.body?.type === "text" && m.body.text === text),
  );
  return { id: mine.id, at };
}
const repliesTo = (qid: string) =>
  messages.filter(
    (m) =>
      m.status === "ok" &&
      m.senderDevice !== deviceId &&
      m.body?.type === "text" &&
      m.body.reply_to === qid &&
      m.body.meta?.trigger !== undefined,
  );

// 1. Two agents, one message.
const q = await ask(QUESTION);
const need = (name: string, tools: string[]) => async () => {
  const dev = agentDeviceOf(name);
  if (!dev) fail(`${name} is not a member of release-7.4`);
  const m = await until(`a reply from ${name}`, WAIT_MS, () =>
    repliesTo(q.id).find((r) => r.senderDevice === dev),
  );
  const body = m.body as Text;
  const used = body.meta?.tools ?? [];
  console.log(
    `${name}: ${secs(q.at)} | tools: ${used.join(", ") || "(none)"} | read: ${body.meta?.read} | local: ${body.meta?.local} | ms: ${body.meta?.ms}`,
  );
  console.log(`${name} reply: ${body.text.slice(0, 400)}`);
  if (!used.some((t) => tools.some((w) => t.includes(w))))
    fail(`${name}: meta.tools has none of ${tools.join("|")}`);
  if (!((body.meta?.read ?? 0) > 0)) fail(`${name}: meta.read is not > 0`);
  if (body.meta?.local !== true) fail(`${name}: meta.local is not true`);
  return m;
};
await Promise.all([need("Ops", OPS_TOOLS)(), need("QA", QA_TOOLS)()]);
for (const name of ["Ops", "QA"]) {
  const dev = agentDeviceOf(name);
  await until(`a ✅ from ${name}`, 30_000, () =>
    messages.find(
      (m) =>
        m.senderDevice === dev &&
        m.body?.type === "reaction" &&
        m.body.target === q.id &&
        m.body.emoji === "✅" &&
        m.body.op === "add",
    ),
  );
  const eyes = messages.find(
    (m) =>
      m.senderDevice === dev &&
      m.body?.type === "reaction" &&
      m.body.target === q.id &&
      m.body.emoji === "👀",
  );
  console.log(
    `${name}: 👀 ${eyes ? `${((eyes.ts - q.at) / 1000).toFixed(1)}s after the question` : "not seen"}, ✅ ok`,
  );
}

// 2. Stop interrupts a live turn.
const dev = agentDeviceOf("Dev");
if (!dev) fail("Dev is not a member of release-7.4");
const stopQ = await ask("@Dev why did the nightly fail?");
const think = await until("a thinking signal from Dev", 60_000, () =>
  activity.find((a) => a.agentDevice === dev && a.at >= stopQ.at && a.turnId),
);
const stoppedAt = Date.now();
await api(`/turns/${encodeURIComponent(think.turnId as string)}/stop`, "POST");
const stopped = await until("'Stopped by Ana.'", 15_000, () =>
  repliesTo(stopQ.id).find((r) => r.body?.type === "text" && r.body.text === "Stopped by Ana."),
);
if ((stopped.body as Text).meta?.stopped_by !== "Ana") fail("meta.stopped_by is not Ana");
console.log(
  `stop: requested ${((stoppedAt - think.at) / 1000).toFixed(1)}s after thinking, confirmed ${secs(stoppedAt)} later`,
);

// 3. Bug 4: vague questions still use a tool.
let withTools = 0;
for (let i = 0; i < VAGUE_RUNS; i++) {
  const v = await ask("@Ops how are things?");
  const r = await until(`vague answer ${i + 1}`, WAIT_MS, () => repliesTo(v.id)[0]);
  const used = (r.body as Text).meta?.tools ?? [];
  if (used.length > 0) withTools++;
  console.log(`vague ${i + 1}: ${secs(v.at)} | tools: ${used.join(", ") || "(none)"}`);
}
console.log(`vague questions with a tool: ${withTools}/${VAGUE_RUNS}`);
client.close();
if (withTools < VAGUE_MIN_WITH_TOOLS)
  fail(`only ${withTools} of ${VAGUE_RUNS} vague questions used a tool`);
console.log("roster-smoke OK");
process.exit(0);
