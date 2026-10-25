// Live smoke: teach a roster agent a document, ask in a shared chat and get a cited answer; gated
// tool approve and deny round-trips; an `ask` sharing policy holds an answer until it is approved.
// Needs `make up` and `make dev` running, and the PIN of `ana` in .run/demo-pins.txt.
// Model output is nondeterministic: structure is asserted, each LLM check gets one retry.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatEngine, type ChatMessage, MemoryKeyStore, RelayClient } from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import type { Agent, Approval, Chat, LoginResponse } from "@sa/protocol";

const ROOT = join(import.meta.dirname, "..", "..");
const BRIDGE = process.env.SA_BRIDGE_URL ?? "http://127.0.0.1:8647";
const RELAY_WS = process.env.SA_RELAY_URL ?? "ws://127.0.0.1:8648";
const OUTBOX = process.env.SA_OUTBOX_DIR ?? join(ROOT, ".run", "outbox");
const WAIT_MS = 240_000;
const GiB = 1024 ** 3;

const ASK = "@Tech according to the contract we taught you, what is the termination notice period?";
const EMAIL =
  "@Sales save a short follow-up email to buyer@northwind.example confirming the 7.4 date.";

function pinOf(user: string): string {
  const line = readFileSync(join(ROOT, ".run", "demo-pins.txt"), "utf8")
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secs = (from: number) => `${((Date.now() - from) / 1000).toFixed(1)}s`;
const results: { step: string; ok: boolean; note: string }[] = [];
const fail = (msg: string): never => {
  throw new Error(msg);
};

async function until<T>(what: string, ms: number, probe: () => T | undefined): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = probe();
    if (v !== undefined) return v;
    await sleep(200);
  }
  return fail(`${what} within ${ms / 1000}s`);
}

/** Runs one step; an LLM step may run more than once. Records pass/fail, never throws. */
async function step(name: string, tries: number, run: () => Promise<string>): Promise<boolean> {
  for (let i = 1; i <= tries; i++) {
    const t0 = Date.now();
    try {
      const note = await run();
      results.push({ step: name, ok: true, note: `${note} (attempt ${i}, ${secs(t0)})` });
      console.log(`PASS ${name}: ${note} (attempt ${i}, ${secs(t0)})`);
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`${i < tries ? "retry" : "FAIL"} ${name}: ${msg}`);
      if (i === tries) results.push({ step: name, ok: false, note: msg });
    }
  }
  return false;
}

// Memory headroom, sampled like the agent-teammates live run, plus the memory service.
function sample(label: string) {
  const sh = (c: string) => {
    try {
      return execSync(c, { encoding: "utf8" });
    } catch {
      return "";
    }
  };
  const rssKb = (re: string) =>
    sh(`ps -axo rss=,command= | grep -E '${re}' | grep -v grep | awk '{s+=$1} END {print s+0}'`);
  // The gateways are the processes listening on the agent ports 8701-8709.
  const gwPids = [...new Set(sh("lsof -nP -iTCP:8701-8709 -sTCP:LISTEN -t").split("\n"))]
    .filter(Boolean)
    .join(",");
  const gateways = gwPids
    ? Number(sh(`ps -o rss= -p ${gwPids} | awk '{s+=$1} END {print s+0}'`)) * 1024
    : 0;
  const memory = Number(rssKb("sa-memory|sa_memory")) * 1024;
  const swapMb = Number(/used = ([\d.]+)M/.exec(sh("sysctl vm.swapusage"))?.[1] ?? 0);
  const vm = sh("vm_stat");
  const comp = Number(/occupied by compressor:\s+(\d+)/.exec(vm)?.[1] ?? 0);
  const pageSize = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384);
  const s = { gateways, memory, swap: swapMb * 1024 * 1024, compressor: comp * pageSize };
  console.log(
    `memory[${label}]: gateways ${(s.gateways / GiB).toFixed(2)} GiB, memory service ${(s.memory / GiB).toFixed(2)} GiB, swap used ${swapMb} MiB, compressor ${(s.compressor / GiB).toFixed(2)} GiB`,
  );
  return s;
}
const samples = [sample("start")];

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
engine.onMessage((m) => messages.push(m));

async function room(seed: string): Promise<Chat> {
  for (let i = 0; i < 300; i++) {
    const r = (await api<Chat[]>("/chats")).find((c) => c.seed_key === seed);
    if (r) return r;
    await sleep(200);
  }
  throw new Error(`the ${seed} room is not visible to ana`);
}
const general = await room("general");
const sales = await room("sales");
await engine.start([general.id, sales.id]);
for (const r of [general, sales]) {
  let last = 0;
  let since = Date.now();
  await until(`a stable chat key for ${r.seed_key}`, 60_000, () => {
    void engine.latestEpoch(r.id).then((e) => {
      if (e !== last) {
        last = e;
        since = Date.now();
      }
    });
    return last > 0 && Date.now() - since > 3000 ? true : undefined;
  });
}
const chats = await api<Chat[]>("/chats");
const deviceOfAgent = (chat: Chat, name: string) =>
  chats
    .find((c) => c.id === chat.id)
    ?.members.find((x) => x.member_type === "agent" && x.display_name === name)?.devices[0]
    ?.device_id;

// Ana's own event stream: the approvals addressed to her.
const approvals: { at: number; a: Approval }[] = [];
const sse = new AbortController();
void (async () => {
  const res = await fetch(`${BRIDGE}/api/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: sse.signal,
  });
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i = buf.indexOf("\n\n");
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (line.startsWith("data: ")) {
        const e = JSON.parse(line.slice(6)) as { type: string; approval?: Approval };
        if (e.type === "approval" && e.approval) approvals.push({ at: Date.now(), a: e.approval });
      }
      i = buf.indexOf("\n\n");
    }
  }
})().catch(() => {});

const agents = await api<Agent[]>("/agents");
const tech = agents.find((x) => x.name === "Tech" && x.scope === "workspace");
if (!tech) throw new Error("no workspace agent Tech");

type Text = Extract<NonNullable<ChatMessage["body"]>, { type: "text" }>;
async function ask(chat: Chat, text: string): Promise<{ id: string; at: number }> {
  const seen = messages.length;
  const at = Date.now();
  await engine.sendText(chat.id, text);
  const mine = await until("own message echoed", 15_000, () =>
    messages
      .slice(seen)
      .find((m) => m.senderDevice === deviceId && m.body?.type === "text" && m.body.text === text),
  );
  return { id: mine.id, at };
}
const repliesTo = (qid: string, dev?: string) =>
  messages.filter(
    (m) =>
      m.status === "ok" &&
      m.senderDevice !== deviceId &&
      (dev === undefined || m.senderDevice === dev) &&
      m.body?.type === "text" &&
      m.body.reply_to === qid &&
      m.body.meta?.trigger !== undefined,
  );
const emls = () =>
  existsSync(OUTBOX) ? readdirSync(OUTBOX).filter((f) => f.endsWith(".eml")) : [];
const timings: string[] = [];

// 1. Teach.
const taught = await step("1 teach contract.txt to Tech", 1, async () => {
  const body = readFileSync(join(import.meta.dirname, "fixtures", "contract.txt"));
  const res = await fetch(`${BRIDGE}/api/agents/${tech.id}/knowledge`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("contract.txt"),
      "x-file-type": "text/plain",
    },
    body,
  });
  if (!res.ok) return fail(`upload failed: ${res.status}`);
  const item = (await res.json()) as { id: string; title: string };
  return `item ${item.id} (${item.title})`;
});

// 2. Ask in a shared chat; the answer cites the document.
if (taught)
  await step("2 ask in #general, the answer cites contract.txt", 2, async () => {
    const q = await ask(general, ASK);
    const dev = deviceOfAgent(general, "Tech");
    if (!dev) return fail("Tech is not a member of #general");
    const m = await until("a reply from Tech", WAIT_MS, () => repliesTo(q.id, dev)[0]);
    const b = m.body as Text;
    const cites = b.meta?.citations ?? [];
    const cited = /\[\d\]/.test(b.text);
    const line = `question->reply ${secs(q.at)} | tools: ${(b.meta?.tools ?? []).join(", ") || "(none)"} | cited: ${cited} | citations: ${cites.map((c) => `${c.source_type}:${c.title}`).join(", ")}`;
    timings.push(`ask: ${line}`);
    console.log(`  ${line}\n  reply: ${b.text.slice(0, 300)}`);
    if (b.meta?.local !== true) fail("meta.local is not true");
    if (!b.text.includes("47")) fail("reply does not contain 47");
    if (!cites.some((c) => c.source_type === "doc" && (c.title ?? "").startsWith("contract.txt")))
      fail("no doc citation for contract.txt");
    return `cited: ${cited}, ${secs(q.at)}`;
  });
samples.push(sample("after-ask"));

// 3 and 4. Gated tool: approve, then deny.
const salesDev = deviceOfAgent(sales, "Sales");
async function gated(decision: "approve" | "deny"): Promise<string> {
  const emlBefore = emls();
  const seen = approvals.length;
  const q = await ask(sales, EMAIL);
  const ev = await until("an email_send approval for Ana", WAIT_MS, () =>
    approvals.slice(seen).find((x) => x.a.tool === "email_send" && x.a.status === "pending"),
  );
  const line = `question->approval ${((ev.at - q.at) / 1000).toFixed(1)}s`;
  timings.push(`${decision}: ${line}`);
  console.log(`  ${line} | approver: ${ev.a.approver_name}`);
  const t0 = Date.now();
  await api(`/approvals/${ev.a.id}/decision`, "POST", { decision });
  const word = decision === "approve" ? "Approved by Ana" : "Declined by Ana";
  await until(`stamp "${word}"`, 15_000, () =>
    messages.find(
      (m) =>
        m.senderDevice === salesDev &&
        m.body?.type === "text" &&
        m.body.text.startsWith(word) &&
        m.body.meta?.approval?.id === ev.a.id,
    ),
  );
  if (decision === "approve") {
    await until("a new .eml in the outbox", 15_000, () =>
      emls().length === emlBefore.length + 1 ? true : undefined,
    );
    return `${line}; decision->stamp+eml ${secs(t0)}`;
  }
  await sleep(15_000);
  if (emls().length !== emlBefore.length) fail("a deny wrote an .eml");
  return `${line}; decision->stamp ${secs(t0)}, no new .eml`;
}
await step("3 approve email_send: one .eml and the stamp", 2, () => gated("approve"));
await step("4 deny email_send: no .eml and the stamp", 2, () => gated("deny"));
samples.push(sample("after-gated"));

// 5. Ask sharing: the answer is held until Ana approves, then posted with her name.
await api(`/agents/${tech.id}/sharing`, "PUT", { share_private_in_chats: "ask" });
try {
  await step("5 sharing=ask holds the answer until approve", 2, async () => {
    const seen = approvals.length;
    const q = await ask(general, ASK);
    const dev = deviceOfAgent(general, "Tech");
    const ev = await until("a share_answer approval", WAIT_MS, () =>
      approvals.slice(seen).find((x) => x.a.tool === "share_answer" && x.a.status === "pending"),
    );
    const line = `question->share approval ${((ev.at - q.at) / 1000).toFixed(1)}s`;
    timings.push(`share: ${line}`);
    const leaked = repliesTo(q.id, dev).some((m) => (m.body as Text).text.includes("47"));
    if (leaked) fail("the answer was posted before approval");
    await api(`/approvals/${ev.a.id}/decision`, "POST", { decision: "approve" });
    const posted = await until("the approved answer", 30_000, () =>
      messages.find(
        (m) =>
          m.senderDevice === dev &&
          m.body?.type === "text" &&
          m.body.meta?.approved_by === "Ana" &&
          m.body.text.includes("47"),
      ),
    );
    return `${line}; held until approve, posted approved_by=${(posted.body as Text).meta?.approved_by}`;
  });
} finally {
  await api(`/agents/${tech.id}/sharing`, "PUT", { share_private_in_chats: "always" });
}
samples.push(sample("end"));

// Headroom thresholds, as the agent-teammates live run.
const first = samples[0];
const last = samples[samples.length - 1];
if (first && last) {
  const peakGw = Math.max(...samples.map((s) => s.gateways));
  const ok =
    last.swap - first.swap <= GiB &&
    last.compressor - first.compressor <= 2 * GiB &&
    peakGw <= 2.5 * GiB;
  results.push({
    step: "memory headroom",
    ok,
    note: `gateways peak ${(peakGw / GiB).toFixed(2)} GiB`,
  });
}

sse.abort();
client.close();
console.log("\nTimings:");
for (const t of timings) console.log(`  ${t}`);
console.log("\nSummary:");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.step}: ${r.note}`);
const bad = results.filter((r) => !r.ok);
if (bad.length > 0) {
  console.error(`memory-smoke FAILED: ${bad.map((b) => b.step).join("; ")}`);
  process.exit(1);
}
console.log("memory-smoke OK");
process.exit(0);
