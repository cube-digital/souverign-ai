import type { RelayLink } from "@sa/client";
import { afterEach, expect, it, vi } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import {
  addPersonalAgent,
  createWorld,
  person,
  rekey,
  startChat,
  type World,
} from "./teammates-fixture.js";

let w: World;
afterEach(async () => {
  vi.useRealTimers();
  await w?.close();
});

/** What RelayClient looks like while its socket is dead: status "offline", nothing delivered. */
const deadLink = (inner: RelayLink): RelayLink & { status: string } => ({
  ...inner,
  status: "offline",
  send: async () => {
    throw new Error("offline");
  },
  sync: () => {},
  onDeliver: () => () => {},
  onSignal: () => () => {},
});

it("an agent device whose relay connection is dead is rebuilt, catches up from its cursor and receives new messages", async () => {
  const built: string[] = [];
  w = await createWorld(new EchoRuntime(), ["ana"], {
    linkFactory: (deviceId: string) => {
      built.push(deviceId);
      const live = w.relay.link(deviceId);
      return built.length === 1 ? deadLink(live) : Object.assign(live, { status: "ready" });
    },
  });
  const ana = await person(w, "ana");
  const chat = await startChat(w, ana, "Ops room");

  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    shouldAdvanceTime: true,
  });
  const scout = await addPersonalAgent(w, ana, chat, "Scout");
  await rekey(w, chat, ana, [ana], [scout]);
  expect(built).toEqual([scout.device_id]);

  // dead for 30 s, noticed by the 15 s health check
  await vi.advanceTimersByTimeAsync(50_000);
  await expect.poll(() => built.length, { timeout: 5000 }).toBe(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(built).toEqual([scout.device_id, scout.device_id]);

  vi.useRealTimers();
  await ana.engine.sendText(chat, "ping after the outage");
  await expect
    .poll(
      async () =>
        (
          await w.db.query<{ t: string }>(
            "select body->>'text' as t from sa.messages_plain where device_id = $1 and body->>'text' = 'ping after the outage'",
            [scout.device_id],
          )
        ).length,
      { timeout: 8000 },
    )
    .toBe(1);
}, 30000);
