// Live smoke: the DevOps bot answers a monitoring question on the local LLM, through the app.
// Needs `make up` and `make dev` running, and the PIN of `ana` in .run/demo-pins.txt.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatEngine, type ChatMessage, MemoryKeyStore, RelayClient } from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import type { Agent, Chat, LoginResponse } from "@sa/protocol";

const BRIDGE = process.env.SA_BRIDGE_URL ?? "http://127.0.0.1:8647";
const RELAY_WS = process.env.SA_RELAY_URL ?? "ws://127.0.0.1:8648";
const QUESTION = "@Ops is anything about to go wrong in the cluster in the next few hours?";
const WAIT_MS = 180_000;

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
  console.error(`agents-smoke FAILED: ${msg}`);
  process.exit(1);
}

await cryptoReady();
const login = await api<LoginResponse>("/login", "POST", { user_id: "ana", pin: pinOf("ana") });
token = login.token;

// A Node device for Ana, so the chat key can be shared with it and the reply read.
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

const mine = await api<Agent[]>("/agents");
const ops =
  mine.find((a) => a.name === "Ops") ??
  (await api<Agent>("/agents", "POST", { name: "Ops", template: "devops", soul: "" }));

const directory = await api<{ id: string }[]>("/directory");
const other = directory.find((p) => p.id !== login.user.id);
if (!other) fail("no other user to chat with");
let chat = await api<Chat>("/chats", "POST", {
  title: `Agents smoke ${new Date().toISOString().slice(11, 19)}`,
  member_user_ids: [other.id],
});
chat = await api<Chat>(`/chats/${encodeURIComponent(chat.id)}/agents`, "POST", {
  agent_id: ops.id,
});
await engine.start([chat.id]);
await engine.createEpoch(
  chat.id,
  chat.members.flatMap((m) => m.devices),
);

const reply = new Promise<ChatMessage>((resolve) => {
  engine.onMessage((m) => {
    if (m.status === "ok" && m.body?.type === "text" && m.senderDevice !== deviceId) resolve(m);
  });
});
const started = Date.now();
await engine.sendText(chat.id, QUESTION);
const got = await Promise.race([
  reply,
  new Promise<null>((r) => setTimeout(() => r(null), WAIT_MS)),
]);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
client.close();
if (!got || got.body?.type !== "text") fail(`no reply from Ops within ${WAIT_MS / 1000}s`);

const tools = got.body.meta?.tools ?? [];
console.log(`reply: ${got.body.text}`);
console.log(`tools: ${tools.join(", ") || "(none)"}`);
console.log(`seconds: ${seconds}`);
if (!tools.some((t) => t.includes("cluster_health") || t.includes("metric_trend"))) {
  fail("meta.tools has neither cluster_health nor metric_trend");
}
if (!got.body.text.includes("node-3")) fail("the reply does not mention node-3");
console.log("agents-smoke OK");
process.exit(0);
