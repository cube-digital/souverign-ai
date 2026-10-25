import { afterEach, expect, it } from "vitest";
import { decide } from "../src/approvals/service.js";
import { sweep } from "../src/calls/publish.js";
import { type CallsWorld, callsWorld, DM, type PostedAs } from "./call-fixture.js";

let w: CallsWorld;
afterEach(async () => {
  await w.close();
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const dms = (state: string) =>
  w.posts.filter((p: PostedAs) => p.opts?.meta?.call_notes?.state === state);
const pending = (id: string) =>
  w.db
    .query<{ dm_pending: string | null; dm_tries: number }>(
      "select dm_pending, dm_tries from sa.call_notes where id = $1",
      [id],
    )
    .then((r) => r[0]);

/** Scribe cannot post in the DM for the next `n` attempts (the DM is not keyed yet). */
function notReadyFor(n: number): { tries: () => number } {
  const real = w.host.postAs;
  let tries = 0;
  w.host.postAs = async (...a: Parameters<NonNullable<typeof real>>) => {
    tries++;
    if (tries <= n) throw new Error("agent_not_ready");
    return real ? real(...a) : "";
  };
  return { tries: () => tries };
}

it("a not-published DM that fails is retried by a later sweep, once delivered never again", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  const host = notReadyFor(1);
  await decide(n.approvalId, "ana", { decision: "deny" });
  expect(dms("not_published")).toEqual([]);
  expect(await pending(n.notesId)).toEqual({ dm_pending: "not_published", dm_tries: 1 });

  const now = Date.now();
  await sweep(now + MIN);
  expect(host.tries()).toBe(1);

  await sweep(now + 11 * MIN);
  expect(dms("not_published")).toHaveLength(1);
  expect(dms("not_published")[0]).toMatchObject({
    agentId: "scribe",
    chatId: DM,
    text: "The notes from the call in #Project were not published.",
  });
  expect((await pending(n.notesId))?.dm_pending).toBeNull();

  await sweep(now + 2 * HOUR);
  expect(dms("not_published")).toHaveLength(1);
});

it("a reminder that fails is retried while the approval is pending, and a DM that never gets through stops after six tries", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  const host = notReadyFor(1);
  const now = Date.now();
  await sweep(now + 20 * HOUR + MIN);
  expect(dms("pending")).toEqual([]);
  expect((await pending(n.notesId))?.dm_pending).toBe("reminder");

  await sweep(now + 20 * HOUR + 12 * MIN);
  expect(dms("pending")).toHaveLength(1);
  expect(dms("pending")[0]?.text).toMatch(
    /still waiting for your approval\. They expire in 4 hours\.$/,
  );
  expect(host.tries()).toBe(2);

  // the DM never gets through: one first try and five retries, then the notes are left alone
  const never = notReadyFor(Number.POSITIVE_INFINITY);
  await decide(n.approvalId, "ana", { decision: "deny" });
  for (let i = 1; i <= 30; i++) await sweep(now + 21 * HOUR + i * HOUR);
  expect(never.tries()).toBe(6);
  expect(await pending(n.notesId)).toEqual({ dm_pending: null, dm_tries: 6 });
});
