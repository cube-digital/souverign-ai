import type { ChatMessage } from "@sa/client";
import { afterEach, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import {
  auth,
  createWorld,
  insertWorkspaceAgent,
  person,
  replyToOf,
  type World,
} from "./teammates-fixture.js";
import { FakeAudio } from "./voice-fixture.js";

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

it("answers a top-level voice message in a DM in the thread under it", async () => {
  w = await createWorld(new EchoRuntime(), ["ana"], {
    audio: new FakeAudio({ text: "What is on the agenda today?" }),
  });
  const ana = await person(w, "ana");
  const scribe = await insertWorkspaceAgent(w, {
    id: "ag-scribe",
    name: "Scribe",
    rosterId: "scribe",
    template: "scribe",
  });
  const r = await w.app.inject({
    method: "POST",
    url: `/api/agents/${scribe.id}/dm`,
    headers: auth(ana.token),
  });
  const dm = r.json() as { id: string; members: { devices: never[] }[] };
  await ana.engine.start([dm.id]);
  await ana.engine.createEpoch(
    dm.id,
    dm.members.flatMap((m) => m.devices),
  );

  const voiceId = await ana.engine.sendFile(
    dm.id,
    { name: "voice-1.webm", mime: "audio/webm", bytes: new Uint8Array([1, 2, 3]) },
    { voice: { duration_ms: 1500 } },
  );
  const answers = (): ChatMessage[] =>
    ana.seen.filter(
      (m) =>
        m.senderDevice === scribe.device_id &&
        m.status === "ok" &&
        m.body?.type === "text" &&
        (m.body.meta?.transcript_of === voiceId || m.body.meta?.audio_id !== undefined),
    );
  await expect.poll(() => answers().length, { timeout: 15000 }).toBe(2);
  expect(answers().map(replyToOf)).toEqual([voiceId, voiceId]);
}, 25000);
