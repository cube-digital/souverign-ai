// Live smoke: a call with three synthetic speakers, one decliner and the notetaker.
// Needs `make up`, `make dev` (SA_NOTETAKER=worker), `bash e2e/live/voice-fixtures.sh`,
// the PINs in .run/demo-pins.txt and livekit-server on PATH (prints SKIPPED and exits 0 otherwise).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatEngine, type ChatMessage, MemoryKeyStore, RelayClient } from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import type {
  Agent,
  Approval,
  CallInfo,
  CallSegment,
  CallToken,
  Chat,
  LoginResponse,
} from "@sa/protocol";

const ROOT = join(import.meta.dirname, "..", "..");

function onPath(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
if (!onPath("livekit-server")) {
  console.log("SKIPPED: livekit-server is not installed (human step: brew install livekit)");
  process.exit(0);
}

const BRIDGE = process.env.SA_BRIDGE_URL ?? "http://127.0.0.1:8647";
const RELAY_WS = process.env.SA_RELAY_URL ?? "ws://127.0.0.1:8648";
const SEGMENTS_MS = 120_000;
const NOTES_MS = 240_000;
const PUBLISH_MS = 30_000;
const ASK_MS = 240_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function pinOf(user: string): string {
  const line = readFileSync(join(ROOT, ".run", "demo-pins.txt"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${user}:`));
  if (!line) throw new Error(`no PIN for ${user} in .run/demo-pins.txt`);
  return line.slice(user.length + 1).trim();
}

type Session = { token: string; id: string };
async function raw(s: Session | null, path: string, method = "GET", body?: unknown) {
  return await fetch(`${BRIDGE}/api${path}`, {
    method,
    headers: {
      ...(s ? { authorization: `Bearer ${s.token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function api<T>(s: Session | null, path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await raw(s, path, method, body);
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}
async function loginAs(user: string): Promise<Session> {
  const r = await api<LoginResponse>(null, "/login", "POST", { user_id: user, pin: pinOf(user) });
  return { token: r.token, id: r.user.id };
}

// Memory headroom: the same thresholds as the agent teammates live check.
const GIB = 1024 ** 3;
type Mem = { label: string; gatewayRss: number; swapUsed: number; compressor: number };
function sampleMem(label: string): Mem {
  // The roster gateways listen on 8701-8709; their command line is a wrapper, so go by port.
  let kb = 0;
  let pids: string[] = [];
  try {
    pids = [
      ...new Set(
        execFileSync("lsof", ["-nP", "-iTCP:8701-8709", "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
          .split("\n")
          .filter(Boolean),
      ),
    ];
  } catch {
    // none listening
  }
  for (const pid of pids) {
    kb += Number(execFileSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" }).trim()) || 0;
  }
  const swap = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" });
  const used = /used = ([\d.]+)([MG])/.exec(swap);
  const swapUsed = used ? Number(used[1]) * (used[2] === "G" ? GIB : 1024 ** 2) : 0;
  const vm = execFileSync("vm_stat", { encoding: "utf8" });
  const page = Number(/page size of (\d+) bytes/.exec(vm)?.[1] ?? 16384);
  const comp = Number(/Pages occupied by compressor:\s+(\d+)/.exec(vm)?.[1] ?? 0);
  const m = { label, gatewayRss: kb * 1024, swapUsed, compressor: comp * page };
  const g = (n: number) => (n / GIB).toFixed(2);
  console.log(
    `memory ${label}: gateways RSS ${g(m.gatewayRss)} GiB, swap used ${g(m.swapUsed)} GiB, compressor ${g(m.compressor)} GiB`,
  );
  return m;
}

const children: ChildProcess[] = [];
function stopAll() {
  for (const c of children) {
    if (c.pid) {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  try {
    execFileSync("bash", ["infra/scripts/livekit.sh", "stop"], { cwd: ROOT, stdio: "ignore" });
  } catch {
    // best effort
  }
}
function fail(msg: string): never {
  console.error(`call-smoke FAILED: ${msg}`);
  stopAll();
  process.exit(1);
}

async function until<T>(
  what: string,
  ms: number,
  probe: () => Promise<T | undefined> | T | undefined,
) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) fail(`${what} (waited ${ms / 1000}s)`);
    await sleep(1000);
  }
}

const mem: Mem[] = [sampleMem("before")];
console.log(
  execFileSync("bash", ["infra/scripts/livekit.sh", "start"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim(),
);

await cryptoReady();
const ana = await loginAs("ana");
const vlad = await loginAs("vlad");
const rares = await loginAs("rares");

// Vlad and Rareș only need a registered device for the chat to be created; they join by API.
for (const s of [vlad, rares]) {
  const k = newDeviceKeys();
  await api(s, "/devices", "POST", {
    device_id: deviceIdFor(k.publicKey),
    public_key: k.publicKey,
  });
}
const keys = newDeviceKeys();
const deviceId = deviceIdFor(keys.publicKey);
await api(ana, "/devices", "POST", { device_id: deviceId, public_key: keys.publicKey });
const store = new MemoryKeyStore();
await store.putDevice({ deviceId, keys });
const client = new RelayClient({
  url: `${RELAY_WS.replace(/^http/, "ws").replace(/\/$/, "")}/relay/ws`,
  deviceId,
  getTicket: async () =>
    (await api<{ ticket: string }>(ana, "/relay-ticket", "POST", { device_id: deviceId })).ticket,
});
await client.connect();
const engine = new ChatEngine({ link: client, store, device: { deviceId, keys } });
const inbox: ChatMessage[] = [];
engine.onMessage((m) => {
  if (m.status === "ok" && m.senderDevice !== deviceId) inbox.push(m);
});

const scribe = (await api<Agent[]>(ana, "/agents")).find(
  (a) => a.name === "Scribe" && a.scope === "workspace",
);
if (!scribe) fail("no workspace Scribe agent");

// 2. Ana creates the group with Vlad, Rareș and Scribe, starts a call and sets the anchor.
let chat = await api<Chat>(ana, "/chats", "POST", {
  title: `Call smoke ${new Date().toISOString().slice(11, 19)}`,
  member_user_ids: [vlad.id, rares.id],
});
chat = await api<Chat>(ana, `/chats/${encodeURIComponent(chat.id)}/agents`, "POST", {
  agent_id: scribe.id,
});
await engine.start([chat.id]);
const claim = await api<{ epoch: number }>(
  ana,
  `/chats/${encodeURIComponent(chat.id)}/epoch`,
  "POST",
  {
    min: (await engine.latestEpoch(chat.id)) + 1,
  },
);
await engine.createEpoch(
  chat.id,
  chat.members.flatMap((m) => m.devices),
  claim.epoch,
);
const anchor = await engine.sendText(chat.id, "Starting the weekly sync call.");
const started = await api<{ call: CallInfo }>(
  ana,
  `/chats/${encodeURIComponent(chat.id)}/calls`,
  "POST",
);
const callId = started.call.id;
await api(ana, `/calls/${callId}/anchor`, "POST", { message_id: anchor });
const tokens: Record<string, CallToken> = {};
for (const [name, s] of [
  ["ana", ana],
  ["vlad", vlad],
  ["rares", rares],
] as const) {
  tokens[name] = await api<CallToken>(s, `/calls/${callId}/token`, "POST");
  if (!tokens[name]?.available || !tokens[name]?.token)
    fail(`no call token for ${name} (call server unavailable)`);
}
console.log(`call ${callId}: three tokens, e2ee=${started.call.e2ee}`);

// 3. Ana invites the notetaker. Vlad accepts, Rareș declines.
await api(ana, `/calls/${callId}/notetaker`, "POST", {});
await api(vlad, `/calls/${callId}/consent`, "POST", { decision: "accepted" });
await api(rares, `/calls/${callId}/consent`, "POST", { decision: "declined" });
const joined = await until("the notetaker worker did not join", 60_000, async () => {
  const i = await api<CallInfo>(ana, `/calls/${callId}`);
  return i.notetaker?.worker === "joined"
    ? i
    : i.notetaker?.worker === "error"
      ? fail("worker error")
      : undefined;
});
console.log(`notetaker: status ${joined.notetaker?.status}, worker ${joined.notetaker?.worker}`);
mem.push(sampleMem("during call (notetaker joined)"));

// 4. Three synthetic speakers publish the fixtures.
function synth(name: string) {
  const t = tokens[name];
  if (!t) fail(`no token for ${name}`);
  const c = spawn(
    "uv",
    [
      "run",
      "--project",
      ROOT,
      "--no-sync",
      "sa-meeting",
      "synth",
      "--url",
      t.url,
      "--token-stdin",
      "--wav",
      join(ROOT, ".run", "fixtures", `${name}.wav`),
    ],
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], detached: true },
  );
  c.stdin?.end(`${t.token}\n`);
  children.push(c);
  return new Promise<number | null>((resolve) => c.on("exit", resolve));
}
const playing = ["ana", "vlad", "rares"].map(synth);

// 5. Segments from exactly {ana, vlad}.
const text = (xs: CallSegment[]) => xs.map((s) => s.text.toLowerCase()).join(" | ");
const getSegments = async () =>
  (await api<{ segments: CallSegment[] }>(ana, `/calls/${callId}/segments`)).segments;
const segs = await until("segments never covered both speakers", SEGMENTS_MS, async () => {
  const xs = await getSegments();
  const t = text(xs);
  return new Set(xs.map((s) => s.speaker_user_id)).has("vlad") &&
    t.includes("delivery") &&
    t.includes("email")
    ? xs
    : undefined;
});
await Promise.all(playing);
await sleep(8000); // let the last segment flush
const all = await getSegments();
const speakers = [...new Set(all.map((s) => s.speaker_user_id))].sort();
console.log(`segments: ${all.length}, speakers: ${speakers.join(",")}, first ${segs.length}`);
for (const s of all) console.log(`  [${s.speaker_user_id} @${s.t_ms} ms] ${s.text.length} chars`);
if (all.length < 2) fail(`expected at least 2 segments, got ${all.length}`);
if (speakers.join(",") !== "ana,vlad")
  fail(`speakers are ${speakers.join(",")}, expected ana,vlad`);
const joinedText = text(all);
if (!joinedText.includes("delivery") || !joinedText.includes("email"))
  fail("segments miss delivery/email");
if (/ninety|budget/.test(joinedText) || speakers.includes("rares"))
  fail("the decliner was captured");
console.log("segments: PASS (decliner not captured)");

// 8. Chat voice during the call: synth tracks play again while one voice round runs.
mem.push(sampleMem("during call (voice round)"));
const second = ["ana", "vlad", "rares"].map(synth);
const voice = spawn("pnpm", ["--filter", "@sa/e2e", "run", "voice-smoke"], {
  cwd: ROOT,
  env: { ...process.env, SA_VOICE_RUNS: "1", SA_VOICE_WARMUP: "0" },
  stdio: ["ignore", "pipe", "inherit"],
});
let voiceOut = "";
voice.stdout?.on("data", (d) => {
  voiceOut += String(d);
});
const voiceCode = await new Promise<number | null>((resolve) => voice.on("exit", resolve));
await Promise.all(second);
for (const l of voiceOut.split("\n"))
  if (/^(run |stt|first|total)/.test(l)) console.log(`voice during call: ${l}`);
console.log(`voice during call: ${voiceCode === 0 ? "PASS" : "FAIL"}`);
if (voiceCode !== 0) fail("voice round during the call failed");

// 6. Ana ends the call; notes stay private until approved.
await api(ana, `/calls/${callId}/end`, "POST");
const notesAs = async (s: Session) => (await raw(s, `/calls/${callId}/notes`)).status;
if ((await notesAs(vlad)) !== 403 || (await notesAs(rares)) !== 403)
  fail("notes were readable by a non-inviter");
const approval = await until("no pending notes approval for Ana", NOTES_MS, async () => {
  const list = await api<Approval[]>(ana, "/approvals");
  return list.find((a) => a.tool === "call_notes_publish" && a.args.call_id === callId);
});
if (inbox.some((m) => m.body?.type === "text" && m.body.meta?.meeting))
  fail("notes were posted before approval");
const notesText = String(approval.args.text ?? "").toLowerCase();
if (/ninety|budget|rare/.test(notesText)) fail("the draft notes mention the decliner");
console.log(
  `approval ${approval.id}: pending for Ana, notes ${notesText.length} chars, private until approval`,
);
await api(ana, `/approvals/${approval.id}/decision`, "POST", { decision: "approve" });
const posted = await until("Scribe never posted the notes in the thread", PUBLISH_MS, () =>
  inbox.find((m) => m.body?.type === "text" && m.body.reply_to === anchor && m.body.meta?.meeting),
);
console.log(`notes posted in the call thread (message ${posted.id})`);
if ((await notesAs(vlad)) !== 403)
  console.log("note: non-inviter notes endpoint changed after publish");

// 7. A follow-up question reads the transcript tool.
mem.push(sampleMem("after notes"));
const q = "@Scribe what did we decide in the call?";
const qid = await engine.sendText(chat.id, q);
const t0 = Date.now();
const answer = await until("no answer to the follow-up", ASK_MS, () =>
  inbox.find((m) => m.body?.type === "text" && m.body.reply_to === qid && !m.body.meta?.meeting),
);
if (answer.body?.type !== "text") fail("answer is not text");
const tools = answer.body.meta?.tools ?? [];
console.log(
  `follow-up: ${((Date.now() - t0) / 1000).toFixed(1)} s, tools: ${tools.join(", ") || "(none)"}`,
);
if (!tools.some((t) => t.includes("meeting_transcript")))
  fail("the answer did not use meeting_transcript");
if (!/march|delivery/i.test(answer.body.text))
  fail("the answer does not mention March or delivery");
console.log("follow-up: PASS");

// Worker log lines (ids and counts only).
const logDir = join(ROOT, ".run", "notetakers");
if (existsSync(logDir)) {
  for (const f of readdirSync(logDir).filter((x) => x.endsWith(".log"))) {
    console.log(`worker log ${f}:\n${readFileSync(join(logDir, f), "utf8").trim()}`);
  }
}

mem.push(sampleMem("end"));
const first = mem[0];
const last = mem[mem.length - 1];
if (first && last) {
  const peak = Math.max(...mem.map((m) => m.gatewayRss));
  const bad: string[] = [];
  if (last.swapUsed - first.swapUsed > GIB) bad.push("swap grew by more than 1 GiB");
  if (last.compressor - first.compressor > 2 * GIB) bad.push("compressor grew by more than 2 GiB");
  if (peak > 2.5 * GIB) bad.push("gateways RSS above 2.5 GiB");
  console.log(`memory headroom: ${bad.length === 0 ? "PASS" : `FAIL (${bad.join("; ")})`}`);
  if (bad.length > 0) fail(bad.join("; "));
}
client.close();
stopAll();
console.log("call-smoke OK");
process.exit(0);
