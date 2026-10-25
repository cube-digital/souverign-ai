import { cryptoReady, deviceIdFor, newDeviceKeys, randomId } from "@sa/crypto";
import type { DevicePublic } from "@sa/protocol";
import { beforeAll, expect, it } from "vitest";
import { ChatEngine, MemoryKeyStore } from "../src/index.js";
import { FakeRelay } from "./fake-relay.js";

beforeAll(async () => {
  await cryptoReady();
});

it("engine sends resolve the id of the envelope the relay received", async () => {
  const relay = new FakeRelay();
  const chat = randomId();
  const keys = newDeviceKeys();
  const deviceId = deviceIdFor(keys.publicKey);
  const device = { deviceId, keys };
  const store = new MemoryKeyStore();
  await store.putDevice(device);
  const engine = new ChatEngine({ link: relay.link(deviceId), store, device });
  const seen: { id: string; body: unknown }[] = [];
  engine.onMessage((m) => seen.push(m as { id: string; body: unknown }));
  relay.addMember(chat, deviceId);
  await engine.start([chat]);
  const pub: DevicePublic = { device_id: deviceId, public_key: keys.publicKey };
  await engine.createEpoch(chat, [pub]);

  const textId = await engine.sendText(chat, "hello");
  const fileId = await engine.sendFile(
    chat,
    { name: "v.webm", mime: "audio/webm", bytes: new Uint8Array([1, 2, 3]) },
    { voice: { duration_ms: 4200 } },
  );

  const msgEnvIds = relay.log.filter((s) => s.env.kind === "msg").map((s) => s.env.id);
  expect(msgEnvIds).toEqual([textId, fileId]);
  await expect.poll(() => seen.length).toBe(2);
  const fileBody = seen.find((m) => m.id === fileId)?.body as { voice?: unknown };
  expect(fileBody.voice).toEqual({ duration_ms: 4200 });
});
