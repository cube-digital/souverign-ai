import { cryptoReady, deviceIdFor, newDeviceKeys, randomId } from "@sa/crypto";
import type { DevicePublic } from "@sa/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { ChatEngine, MemoryKeyStore } from "../src/index.js";
import { FakeRelay } from "./fake-relay.js";

type Msg = { id: string; epoch: number; status: string; body: unknown; senderDevice: string };

beforeAll(async () => {
  await cryptoReady();
});

async function makeDevice(
  relay: FakeRelay,
  isTrustedKeySender?: (chatId: string, senderDevice: string) => Promise<boolean>,
) {
  const keys = newDeviceKeys();
  const deviceId = deviceIdFor(keys.publicKey);
  const device = { deviceId, keys };
  const store = new MemoryKeyStore();
  await store.putDevice(device);
  const engine = new ChatEngine({
    link: relay.link(deviceId),
    store,
    device,
    isTrustedKeySender,
  });
  const seen: Msg[] = [];
  engine.onMessage((m) => seen.push(m as Msg));
  const pub: DevicePublic = { device_id: deviceId, public_key: keys.publicKey };
  return { engine, seen, pub, deviceId };
}

const texts = (seen: Msg[]) =>
  seen.map((m) => (m.body as { text?: string } | null)?.text).filter((t) => t !== undefined);

describe("ChatEngine", () => {
  it("members exchange encrypted messages and each sees every message once", async () => {
    const relay = new FakeRelay();
    const chat = randomId();
    const a = await makeDevice(relay);
    const b = await makeDevice(relay);
    relay.addMember(chat, a.deviceId);
    relay.addMember(chat, b.deviceId);
    await a.engine.start([chat]);
    await b.engine.start([chat]);

    const epoch = await a.engine.createEpoch(chat, [a.pub, b.pub]);
    await a.engine.sendText(chat, "hello from a");
    await b.engine.sendText(chat, "hello from b");

    await expect.poll(() => a.seen.length).toBe(2);
    await expect.poll(() => b.seen.length).toBe(2);
    await new Promise((r) => setTimeout(r, 20));

    expect(epoch).toBe(1);
    expect(texts(a.seen)).toEqual(["hello from a", "hello from b"]);
    expect(texts(b.seen)).toEqual(["hello from a", "hello from b"]);
    expect(a.seen.map((m) => m.status)).toEqual(["ok", "ok"]);
    // the relay only ever stored ciphertext
    const stored = JSON.stringify(relay.log);
    expect(stored).not.toContain("hello from a");
  });

  it("a member added later reads new messages but never older ones", async () => {
    const relay = new FakeRelay();
    const chat = randomId();
    const a = await makeDevice(relay);
    const b = await makeDevice(relay);
    const c = await makeDevice(relay);
    relay.addMember(chat, a.deviceId);
    relay.addMember(chat, b.deviceId);
    await a.engine.start([chat]);
    await b.engine.start([chat]);
    await a.engine.createEpoch(chat, [a.pub, b.pub]);
    await a.engine.sendText(chat, "before c");
    await expect.poll(() => b.seen.length).toBe(1);

    relay.addMember(chat, c.deviceId);
    const epoch2 = await a.engine.createEpoch(chat, [a.pub, b.pub, c.pub]);
    await a.engine.sendText(chat, "after c");
    await c.engine.start([chat]);

    await expect.poll(() => c.seen.length).toBe(1);
    await expect.poll(() => b.seen.length).toBe(2);
    await new Promise((r) => setTimeout(r, 20));

    expect(epoch2).toBe(2);
    expect(texts(c.seen)).toEqual(["after c"]);
    expect(c.seen[0]?.epoch).toBe(2);
    expect(c.seen[0]?.status).toBe("ok");
    expect(texts(b.seen)).toEqual(["before c", "after c"]);
  });

  it("files are encrypted on upload and arrive byte-identical", async () => {
    const relay = new FakeRelay();
    const chat = randomId();
    const a = await makeDevice(relay);
    const b = await makeDevice(relay);
    relay.addMember(chat, a.deviceId);
    relay.addMember(chat, b.deviceId);
    await a.engine.start([chat]);
    await b.engine.start([chat]);
    await a.engine.createEpoch(chat, [a.pub, b.pub]);

    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    await a.engine.sendFile(chat, { name: "pic.bin", mime: "application/octet-stream", bytes });

    await expect.poll(() => b.seen.length).toBe(1);
    const body = b.seen[0]?.body as {
      type: string;
      name: string;
      mime: string;
      size: number;
      blob_id: string;
    };
    expect(body).toMatchObject({
      type: "file",
      name: "pic.bin",
      mime: "application/octet-stream",
      size: 10,
    });
    const uploaded = relay.blobs.get(body.blob_id) as Uint8Array;
    expect(Array.from(uploaded)).not.toEqual(Array.from(bytes));
    const downloaded = await b.engine.downloadFile(body as never);
    expect(Array.from(downloaded)).toEqual(Array.from(bytes));
  });

  it("chat keys are accepted only from the chat owner's devices", async () => {
    const relay = new FakeRelay();
    const chatMine = randomId();
    const chatOwned = randomId();
    const owner = await makeDevice(relay);
    const intruder = await makeDevice(relay);
    const trusted = async (_chat: string, sender: string) => sender === owner.deviceId;
    const me = await makeDevice(relay, trusted);
    for (const c of [chatMine, chatOwned]) {
      for (const d of [owner, intruder, me]) relay.addMember(c, d.deviceId);
      await owner.engine.start([c]);
      await intruder.engine.start([c]);
      await me.engine.start([c]);
    }

    // a non-owner seals a key for this device: ignored, so its messages stay pending
    await intruder.engine.createEpoch(chatMine, [intruder.pub, me.pub]);
    await intruder.engine.sendText(chatMine, "from intruder");
    // the owner's key is accepted: its messages decrypt
    await owner.engine.createEpoch(chatOwned, [owner.pub, me.pub]);
    await owner.engine.sendText(chatOwned, "from owner");

    await expect.poll(() => me.seen.length).toBe(2);
    await new Promise((r) => setTimeout(r, 20));

    const byChat = (chat: string) =>
      me.seen.filter((m) => (m as Msg & { chatId: string }).chatId === chat);
    expect(byChat(chatMine).map((m) => [m.status, m.body])).toEqual([["pending", null]]);
    expect(byChat(chatOwned).map((m) => [m.status, m.body])).toEqual([
      ["ok", { type: "text", text: "from owner" }],
    ]);
  });

  it("members exchange encrypted activity that never shows up as a message", async () => {
    const relay = new FakeRelay();
    const chat = randomId();
    const a = await makeDevice(relay);
    const b = await makeDevice(relay);
    relay.addMember(chat, a.deviceId);
    relay.addMember(chat, b.deviceId);
    await a.engine.start([chat]);
    await b.engine.start([chat]);
    await a.engine.createEpoch(chat, [a.pub, b.pub]);
    await new Promise((r) => setTimeout(r, 20));

    const got: unknown[] = [];
    b.engine.onActivity((x) => got.push(x));
    await a.engine.sendActivity(chat, { type: "activity", phase: "tool", tool: "search" });

    await expect.poll(() => got.length).toBe(1);
    expect(got[0]).toMatchObject({
      chatId: chat,
      senderDevice: a.deviceId,
      body: { type: "activity", phase: "tool", tool: "search" },
    });
    expect(b.seen).toEqual([]);
    expect(relay.log.every((s) => s.env.kind !== "status")).toBe(true);
  });

  it("a reply keeps its thread root and a reaction round-trips encrypted", async () => {
    const relay = new FakeRelay();
    const chat = randomId();
    const a = await makeDevice(relay);
    const b = await makeDevice(relay);
    relay.addMember(chat, a.deviceId);
    relay.addMember(chat, b.deviceId);
    await a.engine.start([chat]);
    await b.engine.start([chat]);
    await a.engine.createEpoch(chat, [a.pub, b.pub]);

    await a.engine.sendText(chat, "in thread", undefined, { replyTo: "root_message_1" });
    await a.engine.sendReaction(chat, "root_message_1", "👍", "add");

    await expect.poll(() => b.seen.length).toBe(2);
    expect(b.seen.map((m) => m.body)).toEqual([
      { type: "text", text: "in thread", reply_to: "root_message_1" },
      { type: "reaction", target: "root_message_1", emoji: "👍", op: "add" },
    ]);
    expect(JSON.stringify(relay.log)).not.toContain("root_message_1");
  });

  it("shareEpochs lets a device added later decrypt an epoch-1 message", async () => {
    const relay = new FakeRelay();
    const chat = randomId();
    const a = await makeDevice(relay);
    const c = await makeDevice(relay);
    relay.addMember(chat, a.deviceId);
    await a.engine.start([chat]);
    await a.engine.createEpoch(chat, [a.pub]);
    expect(await a.engine.latestEpoch(chat)).toBe(1);

    relay.addMember(chat, c.deviceId);
    await a.engine.sendText(chat, "epoch one text");
    await c.engine.start([chat]);
    const sent = await a.engine.shareEpochs(chat, c.pub);

    await expect.poll(() => c.seen.map((m) => m.status).at(-1)).toBe("ok");
    expect(sent).toBe(1);
    expect(texts(c.seen)).toEqual(["epoch one text"]);
    expect(c.seen.at(-1)?.epoch).toBe(1);
  });
});
