import { cryptoReady, deviceIdFor, newDeviceKeys, randomId } from "@sa/crypto";
import { beforeAll, expect, it } from "vitest";
import { ChatEngine, MemoryKeyStore } from "../src/index.js";
import { FakeRelay } from "./fake-relay.js";

beforeAll(async () => {
  await cryptoReady();
});

async function member(relay: FakeRelay, chat: string) {
  const keys = newDeviceKeys();
  const deviceId = deviceIdFor(keys.publicKey);
  const device = { deviceId, keys };
  const store = new MemoryKeyStore();
  await store.putDevice(device);
  const engine = new ChatEngine({ link: relay.link(deviceId), store, device });
  const seen: { status: string }[] = [];
  engine.onMessage((m) => seen.push(m));
  relay.addMember(chat, deviceId);
  await engine.start([chat]);
  return { engine, seen, pub: { device_id: deviceId, public_key: keys.publicKey } };
}

it("keeps the first key stored for an epoch when a later envelope claims the same epoch", async () => {
  const relay = new FakeRelay();
  const chat = randomId();
  const a = await member(relay, chat);
  const b = await member(relay, chat);
  const c = await member(relay, chat);

  await a.engine.createEpoch(chat, [a.pub, b.pub, c.pub]);
  await expect.poll(() => b.engine.latestEpoch(chat)).toBe(1);
  // c never saw a's key before minting its own epoch 1 and sends it to b
  const c2 = await member(relay, chat);
  await c2.engine.createEpoch(chat, [b.pub]);
  await new Promise((r) => setTimeout(r, 50));
  await a.engine.sendText(chat, "still readable");

  await expect.poll(() => b.seen.length).toBe(1);
  expect(b.seen[0]?.status).toBe("ok");
});
