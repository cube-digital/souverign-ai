// Live smoke: a voice message to Ops gets a transcript and a spoken reply; prints the latency.
// Needs `make up`, `make dev` and `bash e2e/live/voice-fixtures.sh`, and the PIN of `ana` in .run/demo-pins.txt.
// SA_VOICE_RUNS (default 3) rounds, the first is a warm-up unless SA_VOICE_WARMUP=0.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatEngine, type ChatMessage, MemoryKeyStore, RelayClient } from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import type { Agent, Chat, LoginResponse, VoiceLatency } from "@sa/protocol";

const BRIDGE = process.env.SA_BRIDGE_URL ?? "http://127.0.0.1:8647";
const RELAY_WS = process.env.SA_RELAY_URL ?? "ws://127.0.0.1:8648";
const RUNS = Number(process.env.SA_VOICE_RUNS ?? 3);
const WARMUP = process.env.SA_VOICE_WARMUP === "0" ? 0 : 1;
const WAIT_MS = 120_000;
const ROOT = join(import.meta.dirname, "..", "..");

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

function fail(msg: string): never {
  console.error(`voice-smoke FAILED: ${msg}`);
  process.exit(1);
}

/** Playing time of a PCM WAV in ms, from its fmt and data chunks. */
function wavMs(wav: Uint8Array): number {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (wav.length < 44 || String.fromCharCode(...wav.slice(0, 4)) !== "RIFF") return 0;
  let byteRate = 0;
  let p = 12;
  while (p + 8 <= wav.length) {
    const id = String.fromCharCode(...wav.slice(p, p + 4));
    const size = v.getUint32(p + 4, true);
    if (id === "fmt ") byteRate = v.getUint32(p + 16, true);
    if (id === "data")
      return byteRate ? Math.round((Math.min(size, wav.length - p - 8) / byteRate) * 1000) : 0;
    p += 8 + size + (size % 2);
  }
  return 0;
}

const pct = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? 0;
};

await cryptoReady();
const login = await api<LoginResponse>("/login", "POST", { user_id: "ana", pin: pinOf("ana") });
token = login.token;

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

const ops = (await api<Agent[]>("/agents")).find(
  (a) => a.name === "Ops" && a.scope === "workspace",
);
if (!ops) fail("no workspace Ops agent (start `make dev` and let the roster seed)");
const chat = await api<Chat>(`/agents/${encodeURIComponent(ops.id)}/dm`, "POST");
await engine.start([chat.id]);
const claim = await api<{ epoch: number }>(`/chats/${encodeURIComponent(chat.id)}/epoch`, "POST", {
  min: (await engine.latestEpoch(chat.id)) + 1,
});
await engine.createEpoch(
  chat.id,
  chat.members.flatMap((m) => m.devices),
  claim.epoch,
);

const seen: ChatMessage[] = [];
engine.onMessage((m) => {
  if (m.status === "ok" && m.senderDevice !== deviceId) seen.push(m);
});

const ask = new Uint8Array(readFileSync(join(ROOT, ".run", "fixtures", "ask.webm")));
const askMs = Math.round(
  Number(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        join(ROOT, ".run", "fixtures", "ask.webm"),
      ],
      { encoding: "utf8" },
    ),
  ) * 1000,
);

const rows: { stt: number; token?: number; audio?: number; total: number }[] = [];
for (let run = 1; run <= RUNS; run++) {
  const from = seen.length;
  const sentAt = Date.now();
  const voiceId = await engine.sendFile(
    chat.id,
    { name: "ask.webm", mime: "audio/webm", bytes: ask },
    { voice: { duration_ms: askMs } },
  );
  const deadline = sentAt + WAIT_MS;
  let transcript = "";
  let reply: { audioId: string; latency: VoiceLatency } | undefined;
  while (Date.now() < deadline && !(transcript && reply)) {
    // The agent handles one voice message at a time: a reply counts only after this transcript.
    let mine = false;
    for (const m of seen.slice(from)) {
      if (m.body?.type !== "text") continue;
      const meta = m.body.meta;
      if (meta?.transcript_of === voiceId) {
        transcript = m.body.text;
        mine = true;
      } else if (mine && meta?.audio_id && meta.latency) {
        reply = { audioId: meta.audio_id, latency: meta.latency };
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!transcript) fail(`run ${run}: no transcript within ${WAIT_MS / 1000}s`);
  if (!transcript.toLowerCase().includes("cluster")) {
    fail(`run ${run}: the transcript does not contain "cluster": ${JSON.stringify(transcript)}`);
  }
  if (!reply) fail(`run ${run}: no voice reply (audio_id + latency) within ${WAIT_MS / 1000}s`);
  let file: Extract<NonNullable<ChatMessage["body"]>, { type: "file" }> | undefined;
  while (Date.now() < deadline && !file) {
    for (const m of seen.slice(from)) {
      if (m.id === reply.audioId && m.body?.type === "file") file = m.body;
    }
    if (!file) await new Promise((r) => setTimeout(r, 200));
  }
  if (!file) fail(`run ${run}: the reply's audio message never arrived`);
  const ms = wavMs(await engine.downloadFile(file));
  if (ms <= 500) fail(`run ${run}: the reply audio is ${ms} ms, expected more than 500`);
  const l = reply.latency;
  const wall = Date.now() - sentAt;
  console.log(
    `run ${run}${run <= WARMUP ? " (warm-up)" : ""}: stt ${l.stt_ms} ms / first token ${l.first_token_ms ?? "-"} ms / first audio ${l.first_audio_ms ?? "-"} ms / total ${l.total_ms} ms · wall ${wall} ms · reply audio ${ms} ms`,
  );
  if (run > WARMUP) {
    rows.push({
      stt: l.stt_ms,
      ...(l.first_token_ms === undefined ? {} : { token: l.first_token_ms }),
      ...(l.first_audio_ms === undefined ? {} : { audio: l.first_audio_ms }),
      total: l.total_ms,
    });
  }
}
client.close();

if (rows.length > 0) {
  const col = (k: "stt" | "token" | "audio" | "total") =>
    rows.map((r) => r[k]).filter((x): x is number => x !== undefined);
  for (const [name, k] of [
    ["stt", "stt"],
    ["first token", "token"],
    ["first audio", "audio"],
    ["total", "total"],
  ] as const) {
    const xs = col(k);
    if (xs.length > 0)
      console.log(`${name}: p50 ${pct(xs, 0.5)} ms, p95 ${pct(xs, 0.95)} ms (n=${xs.length})`);
  }
  const fa = col("audio");
  const ok = fa.length > 0 && fa.every((x) => x < 2000);
  console.log(`first_audio_ms < 2000 on fast: ${ok ? "PASS" : "MISS"}`);
}
console.log("voice-smoke OK");
process.exit(0);
