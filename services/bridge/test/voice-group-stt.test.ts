import type { ChatMessage } from "@sa/client";
import { afterEach, describe, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import {
  addPersonalAgent,
  createWorld,
  person,
  reactionsNet,
  rekey,
  sleep,
  startChat,
  type World,
} from "./teammates-fixture.js";
import { FakeAudio } from "./voice-fixture.js";

let w: World;
afterEach(async () => {
  await w?.close();
});

const texts = (viewer: { seen: ChatMessage[] }, deviceId: string) =>
  viewer.seen.filter(
    (m) =>
      m.senderDevice === deviceId &&
      m.body?.type === "text" &&
      (m.body.meta as { trigger?: string } | undefined)?.trigger !== "intro",
  );

async function world(audio: FakeAudio) {
  w = await createWorld(new EchoRuntime(), ["ana"], { audio });
  const ana = await person(w, "ana");
  const chat = await startChat(w, ana, "Ops room");
  const ops = await addPersonalAgent(w, ana, chat, "Ops");
  const scout = await addPersonalAgent(w, ana, chat, "Scout");
  await rekey(w, chat, ana, [ana], [ops, scout]);
  return { ana, chat, ops, scout };
}

describe("voice failures in a group with two agents", () => {
  it("puts one warning on the message and posts no text when STT fails or the transcript is empty", async () => {
    const audio = new FakeAudio({ failStt: true });
    const { ana, chat, ops, scout } = await world(audio);
    const bad = await ana.engine.sendFile(
      chat,
      { name: "v.webm", mime: "audio/webm", bytes: new Uint8Array([1, 2]) },
      { voice: { duration_ms: 1500 } },
    );
    await expect
      .poll(
        () => [
          ...reactionsNet(ana, ops.device_id, bad),
          ...reactionsNet(ana, scout.device_id, bad),
        ],
        { timeout: 8000 },
      )
      .toEqual(["⚠️"]);

    audio.opts.failStt = false;
    audio.opts.text = "";
    const empty = await ana.engine.sendFile(
      chat,
      { name: "v2.webm", mime: "audio/webm", bytes: new Uint8Array([1, 2]) },
      { voice: { duration_ms: 1500 } },
    );
    await expect
      .poll(
        () => [
          ...reactionsNet(ana, ops.device_id, empty),
          ...reactionsNet(ana, scout.device_id, empty),
        ],
        { timeout: 8000 },
      )
      .toEqual(["⚠️"]);
    await sleep(400);
    expect(texts(ana, ops.device_id)).toEqual([]);
    expect(texts(ana, scout.device_id)).toEqual([]);
  }, 25000);

  it("skips a voice message longer than the limit before downloading or transcribing it", async () => {
    const audio = new FakeAudio({ text: "Hey Ops, hi" });
    const { ana, chat, ops, scout } = await world(audio);
    // let both join intros land, so teardown does not race a pending turn
    const introsSeen = () =>
      ana.seen.filter(
        (m) =>
          ((m.body as { meta?: unknown } | undefined)?.meta as { trigger?: string } | undefined)
            ?.trigger === "intro",
      ).length;
    await expect.poll(introsSeen, { timeout: 10000 }).toBe(2);
    await sleep(300);
    const target = await ana.engine.sendText(chat, "stand-in for the long recording");
    await sleep(200);
    const dev = (w.host as unknown as { devices: Map<string, unknown> }).devices.get(ops.id);
    const call = (
      w.host as unknown as { voiceMessage: (...a: unknown[]) => Promise<void> }
    ).voiceMessage.bind(w.host);
    await call(
      dev,
      { id: target, chatId: chat, seq: 99, senderDevice: ana.deviceId, ts: Date.now() },
      {
        type: "file",
        name: "long.webm",
        mime: "audio/webm",
        size: 10,
        voice: { duration_ms: 61000 },
      },
      Date.now(),
    );
    await expect
      .poll(
        () => [
          ...reactionsNet(ana, ops.device_id, target),
          ...reactionsNet(ana, scout.device_id, target),
        ],
        { timeout: 8000 },
      )
      .toEqual(["⚠️"]);
    await sleep(1000); // let the reaction round trip settle before teardown
    expect(audio.transcribed).toEqual([]);
  }, 25000);
});
