import type { RosterId, SeedChannelKey } from "@sa/protocol";

/** Demo colleagues (D-12): `sa.users` with `kind = 'seed'`, keys held by the bridge. */
export const SEED_USERS = [
  { id: "mira", name: "Mira Novak" },
  { id: "tom", name: "Tom Weber" },
  { id: "lea", name: "Lea Moreau" },
] as const;
export type SeedUserId = (typeof SEED_USERS)[number]["id"];

export type SeedMessage = {
  author: SeedUserId | RosterId;
  /** envelope `ts` is back-dated by this many minutes (all above the 5-minute trigger window) */
  minutesAgo: number;
  text: string;
  /** index of an earlier top-level message in the same room: the thread root */
  replyTo?: number;
};

// One story, matching the ops simulator: 7.4.0-rc2 with blockers OPS-1412 and OPS-1419,
// E2E_CallReconnect flaky (3 of the last 5 runs), MR !482 and nightly #9921, node-3 disk at 81%
// growing ~4 points an hour, db-2 lagging behind db-1, Northwind Logistics waiting on 7.4.
export const SEED_HISTORY: Record<SeedChannelKey, SeedMessage[]> = {
  general: [
    {
      author: "mira",
      minutesAgo: 1500,
      text: "Morning all, and welcome. The agents here read along from when they joined; tag one with @ to ask it something.",
    },
    {
      author: "lea",
      minutesAgo: 1480,
      text: "Hello! Northwind keeps asking me when 7.4 lands, so I'm glad we have a date now.",
    },
    {
      author: "tom",
      minutesAgo: 1450,
      text: "The 7.4 date is set: release on 12 Nov. 7.4.0-rc2 is cut, and OPS-1412 is the last blocker.",
    },
    {
      author: "lea",
      minutesAgo: 1440,
      text: "Perfect, that leaves Northwind three days before their 15 Nov go-live.",
      replyTo: 2,
    },
    {
      author: "mira",
      minutesAgo: 1430,
      text: "From ops: node-3 disk and db-2 replication lag are what I'm watching before then. Details in #ops.",
      replyTo: 2,
    },
    {
      author: "tom",
      minutesAgo: 190,
      text: "@Scribe can you give me the week in a few lines? I was out yesterday.",
    },
    {
      author: "scribe",
      minutesAgo: 188,
      text: "The week in short:\n- 7.4 ships on 12 Nov; rc2 is out and OPS-1412 (call reconnect audio on iOS 17) is the blocker.\n- E2E_CallReconnect failed in 3 of the last 5 runs; Dev's fix is MR !482.\n- #ops is watching node-3 disk (above 80%) and db-2 replication lag.\n- Northwind Logistics is waiting on 7.4 for a 15 Nov go-live.",
      replyTo: 5,
    },
    {
      author: "tom",
      minutesAgo: 180,
      text: "Thanks, that's exactly what I needed.",
      replyTo: 5,
    },
    {
      author: "tom",
      minutesAgo: 95,
      text: "Go/no-go for 7.4 happens in #release-7.4 once !482 is green.",
    },
  ],
  ops: [
    {
      author: "mira",
      minutesAgo: 320,
      text: "Heads-up: node-3 disk crossed 80% this morning, and it keeps growing.",
    },
    {
      author: "mira",
      minutesAgo: 318,
      text: "@Ops how long until node-3 fills up?",
    },
    {
      author: "ops",
      minutesAgo: 317,
      text: "node-3 is at 81% disk and growing about 4 points an hour, so it reaches 90% in roughly two hours and fills up in under five. node-1 and node-2 are flat. Next step: run the node-3 disk cleanup runbook today.",
      replyTo: 1,
    },
    {
      author: "tech",
      minutesAgo: 312,
      text: "The node-3 disk cleanup runbook covers it: rotate logs first, then prune old snapshots. node-3 is still a raft follower catching up, so don't restart it during the cleanup.",
      replyTo: 1,
    },
    {
      author: "mira",
      minutesAgo: 305,
      text: "Thanks both. Cleanup on node-3 goes in the maintenance window tonight.",
      replyTo: 1,
    },
    {
      author: "mira",
      minutesAgo: 140,
      text: "Second thing: the db-2 replication lag alert fired again (above 30 s).",
    },
    {
      author: "mira",
      minutesAgo: 139,
      text: "@Ops is db-2 getting worse?",
    },
    {
      author: "ops",
      minutesAgo: 138,
      text: "Yes. db-2 lags db-1 by about 45 s and the lag grows by roughly 18 s an hour; db-3 is in sync. Next step: follow the replication lag runbook before the lag reaches a minute.",
      replyTo: 6,
    },
    {
      author: "mira",
      minutesAgo: 130,
      text: "On it, following the replication lag runbook. I'll post here when db-2 is back in sync.",
      replyTo: 6,
    },
  ],
  "release-7.4": [
    {
      author: "tom",
      minutesAgo: 620,
      text: "Status check for 7.4: rc2 is cut. What's still in the way?",
    },
    {
      author: "tom",
      minutesAgo: 618,
      text: "@QA is 7.4 ready to ship?",
    },
    {
      author: "qa",
      minutesAgo: 617,
      text: "Not yet. Release status is not ready, with two blockers: OPS-1412 (call reconnect drops audio on iOS 17) and OPS-1419 (raft follower lag after restart). E2E_CallReconnect failed in 3 of the last 5 runs.",
      replyTo: 1,
    },
    {
      author: "tom",
      minutesAgo: 610,
      text: "Is E2E_CallReconnect a real failure or just a flake?",
      replyTo: 1,
    },
    {
      author: "qa",
      minutesAgo: 609,
      text: "It has been flaky for six days at a 60% failure rate, and the failures match OPS-1412. I wouldn't mark it known-flaky until the fix lands.",
      replyTo: 1,
    },
    {
      author: "tom",
      minutesAgo: 420,
      text: "@Dev where are we on the fix for OPS-1412?",
    },
    {
      author: "dev",
      minutesAgo: 419,
      text: 'MR !482 "Fix call reconnect audio on iOS 17" targets release/7.4. Its pipeline still fails on E2E_CallReconnect, and nightly #9921 failed in e2e-ios with a timeout at CallReconnectTest.swift:88.',
      replyTo: 5,
    },
    {
      author: "tom",
      minutesAgo: 410,
      text: "OK. Let's get !482 green first; I'll hold the go/no-go until then.",
      replyTo: 5,
    },
    {
      author: "tom",
      minutesAgo: 200,
      text: "Reminder: the 7.4 release checklist is in the docs library. Please tick your parts before go/no-go.",
    },
  ],
  sales: [
    {
      author: "lea",
      minutesAgo: 900,
      text: "Call with Northwind Logistics tomorrow. They want to go live on 7.4 by 15 Nov.",
    },
    {
      author: "lea",
      minutesAgo: 898,
      text: "@Sales can you brief me on the account before the call?",
    },
    {
      author: "sales",
      minutesAgo: 897,
      text: "Northwind Logistics (acc-northwind) plans to go live on 7.4 by 15 Nov. 7.4 is planned for 12 Nov, and rc2 still has one blocker, OPS-1412 (call reconnect audio on iOS 17). I'd commit to the date only once that is fixed.",
      replyTo: 1,
    },
    {
      author: "lea",
      minutesAgo: 890,
      text: "Good. Can you draft a short follow-up I can send after the call?",
      replyTo: 1,
    },
    {
      author: "sales",
      minutesAgo: 889,
      text: 'Draft: "Thanks for the call today. 7.4 is on track for 12 Nov, and we will confirm the date as soon as the last release blocker is closed, which keeps your 15 Nov go-live in reach. I will update you by the end of the week." I have not sent anything; it is yours to edit.',
      replyTo: 1,
    },
    {
      author: "lea",
      minutesAgo: 300,
      text: "Call went well. Northwind is fine with 12 Nov as long as calls on iOS are fixed.",
    },
    {
      author: "lea",
      minutesAgo: 295,
      text: "Tom, please keep me posted on OPS-1412.",
    },
    {
      author: "tom",
      minutesAgo: 280,
      text: "Will do. The fix is MR !482; QA and Dev are on it in #release-7.4.",
      replyTo: 6,
    },
    {
      author: "lea",
      minutesAgo: 120,
      text: "Follow-up sent to Northwind.",
    },
  ],
};
