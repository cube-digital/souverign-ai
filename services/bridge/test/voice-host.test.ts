import type { ChatMessage } from "@sa/client";
import { afterEach, describe, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import { subscribe } from "../src/approvals/events.js";
import {
  activityOf,
  addPersonalAgent,
  auth,
  createWorld,
  metaOf,
  type Person,
  person,
  reactionsNet,
  rekey,
  replyToOf,
  sleep,
  startChat,
  textOf,
  type World,
} from "./teammates-fixture.js";
import { FakeAudio, makeWav } from "./voice-fixture.js";

type Ev = Record<string, any>;
let w: World;
const unsubs: (() => void)[] = [];
afterEach(async () => {
  for (const u of unsubs.splice(0)) u();
  await w?.close();
});

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const speak = (p: Person, chat: string, replyTo?: string) =>
  p.engine.sendFile(
    chat,
    { name: "voice-1.webm", mime: "audio/webm", bytes: BYTES },
    { voice: { duration_ms: 2000 }, ...(replyTo ? { replyTo } : {}) },
  );
const listen = (userId: string): Ev[] => {
  const got: Ev[] = [];
  unsubs.push(subscribe(userId, (e) => got.push(e as Ev)));
  return got;
};
/** Texts and files an agent device posted, as `viewer` saw them, in order (join intro excluded). */
const posts = (viewer: Person, deviceId: string): ChatMessage[] =>
  viewer.seen.filter(
    (m) =>
      m.senderDevice === deviceId &&
      m.status === "ok" &&
      (m.body?.type === "file" ||
        (m.body?.type === "text" && (m.body.meta as Ev | undefined)?.trigger !== "intro")),
  );

async function world(audio: FakeAudio, runtime = new EchoRuntime()) {
  w = await createWorld(runtime, ["ana", "bob"], { audio });
  const ana = await person(w, "ana");
  const bob = await person(w, "bob");
  const chat = await startChat(w, ana, "Ops room", [bob]);
  const ops = await addPersonalAgent(w, ana, chat, "Ops");
  const scout = await addPersonalAgent(w, ana, chat, "Scout");
  await rekey(w, chat, ana, [ana, bob], [ops, scout]);
  return { ana, bob, chat, ops, scout };
}

describe("voice messages in chat", () => {
  it("is transcribed once and answered by only the addressed agent, by voice, with audio and latency for the requester only", async () => {
    const audio = new FakeAudio({ text: "Hey Ops, status?", sttDelayMs: 50 });
    const { ana, chat, ops, scout } = await world(audio);
    const anaEvents = listen("ana");
    const bobEvents = listen("bob");

    const voiceId = await speak(ana, chat);
    await expect.poll(() => posts(ana, ops.device_id).length, { timeout: 10000 }).toBe(3);
    await sleep(500); // the agent's own voice reply must not start another turn

    expect(audio.transcribed).toHaveLength(1);
    expect(audio.transcribed[0]?.filename).toBe("voice-1.webm");
    expect(audio.transcribed[0]?.language).toBe("auto");
    expect(Array.from(audio.transcribed[0]?.bytes ?? [])).toEqual(Array.from(BYTES));
    expect(posts(ana, scout.device_id)).toHaveLength(0);

    const [transcript, file, reply] = posts(ana, ops.device_id) as [
      ChatMessage,
      ChatMessage,
      ChatMessage,
    ];
    expect(posts(ana, ops.device_id)).toHaveLength(3);
    expect(transcript.body?.type).toBe("text");
    expect(textOf(transcript)).toBe("Hey Ops, status?");
    expect(metaOf(transcript)?.transcript_of).toBe(voiceId);
    expect(file.body).toMatchObject({ type: "file", mime: "audio/wav" });
    expect((file.body as Ev).name).toMatch(/^reply-\d+\.wav$/);
    expect(reply.body?.type).toBe("text");
    expect(metaOf(reply)?.audio_id).toBe(file.id);

    const latency = metaOf(reply)?.latency;
    expect(latency.stt_ms).toBeGreaterThanOrEqual(40);
    expect(latency.total_ms).toBeGreaterThanOrEqual(latency.stt_ms);

    const chunks = anaEvents.filter((e) => e.type === "voice.chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_c, i) => i));
    expect(chunks.every((c) => c.source_id === voiceId && c.chat_id === chat)).toBe(true);
    expect(chunks[0]?.wav_b64).toBe(Buffer.from(makeWav(100)).toString("base64"));
    expect((file.body as Ev).voice.duration_ms).toBe(chunks.length * 100);
    const samples = anaEvents.filter((e) => e.type === "latency.sample");
    expect(samples).toHaveLength(1);
    expect(samples[0]?.latency).toEqual(latency);
    expect(bobEvents).toEqual([]);
  }, 25000);

  it("is answered in a DM without a name, and a failed transcription gets a visible reply", async () => {
    const audio = new FakeAudio({ text: "what is the status" });
    w = await createWorld(new EchoRuntime(), ["ana"], { audio });
    const ana = await person(w, "ana");
    const nora = (
      await w.app.inject({
        method: "POST",
        url: "/api/agents",
        headers: auth(ana.token),
        payload: { name: "Nora", template: "general", soul: "" },
      })
    ).json() as { id: string; device_id: string };
    const dm = await w.app.inject({
      method: "POST",
      url: `/api/agents/${nora.id}/dm`,
      headers: auth(ana.token),
    });
    const chat = dm.json().id as string;
    await ana.engine.start([chat]);
    await rekey(w, chat, ana, [ana], [nora]);

    await speak(ana, chat);
    await expect.poll(() => posts(ana, nora.device_id).length, { timeout: 10000 }).toBe(3);
    expect(textOf(posts(ana, nora.device_id)[0] as ChatMessage)).toBe("what is the status");

    audio.opts.failStt = true;
    const before = posts(ana, nora.device_id).length;
    const badId = await speak(ana, chat);
    await expect.poll(() => posts(ana, nora.device_id).length, { timeout: 10000 }).toBe(before + 1);
    const err = posts(ana, nora.device_id)[before] as ChatMessage;
    expect(textOf(err)).toBe("I couldn't transcribe that voice message.");
    expect(replyToOf(err)).toBe(badId);
    await expect
      .poll(() => reactionsNet(ana, nora.device_id, badId), { timeout: 5000 })
      .toEqual(["⚠️"]);
    expect(posts(ana, nora.device_id)).toHaveLength(before + 1);
  }, 25000);

  it("sends no audio when the requester stops the turn", async () => {
    const audio = new FakeAudio({ text: "Hey Ops, write me a long report" });
    const { ana, chat, ops } = await world(audio, new EchoRuntime({ delayMs: 2000 }));

    await speak(ana, chat);
    await expect
      .poll(() => activityOf(ana, ops.device_id).find((a) => a.body.turn_id)?.body.turn_id, {
        timeout: 8000,
      })
      .toBeTruthy();
    const turnId = activityOf(ana, ops.device_id).find((a) => a.body.turn_id)?.body
      .turn_id as string;
    const r = await w.app.inject({
      method: "POST",
      url: `/api/turns/${turnId}/stop`,
      headers: auth(ana.token),
    });
    expect(r.statusCode).toBe(200);

    await sleep(3500);
    const out = posts(ana, ops.device_id);
    expect(out.filter((m) => m.body?.type === "file")).toEqual([]);
    expect(out.map((m) => textOf(m))).toContain("Stopped by Ana.");
    expect(audio.spoken).toEqual([]);
  }, 25000);
});
