// Seeded dev, docs and CRM data. One story: the 7.4 release, MR !482 and Northwind's go-live.
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const iso = (ms: number) => new Date(ms).toISOString();

type Pipeline = {
  id: string;
  ref: string;
  status: "failed" | "passed" | "running";
  failed_job: string | null;
  ago: number;
  duration_s: number;
};

const PIPELINES: Pipeline[] = [
  {
    id: "9934",
    ref: "mr/482-call-reconnect-audio",
    status: "failed",
    failed_job: "e2e-ios",
    ago: 40 * MIN,
    duration_s: 1260,
  },
  {
    id: "9928",
    ref: "release/7.4",
    status: "passed",
    failed_job: null,
    ago: 5 * HOUR,
    duration_s: 1510,
  },
  {
    id: "9921",
    ref: "nightly",
    status: "failed",
    failed_job: "e2e-ios",
    ago: 9 * HOUR,
    duration_s: 1740,
  },
  {
    id: "9915",
    ref: "mr/479-token-refresh",
    status: "passed",
    failed_job: null,
    ago: 20 * HOUR,
    duration_s: 1320,
  },
  {
    id: "9907",
    ref: "nightly",
    status: "passed",
    failed_job: null,
    ago: 33 * HOUR,
    duration_s: 1695,
  },
  {
    id: "9899",
    ref: "release/7.4",
    status: "passed",
    failed_job: null,
    ago: 2 * DAY,
    duration_s: 1480,
  },
];

const LOGS: Record<string, { job: string; lines: string[] }> = {
  "9921": {
    job: "e2e-ios",
    lines: [
      "$ xcodebuild test -scheme E2E -destination 'platform=iOS Simulator,name=iPhone 15,OS=17.2'",
      "Test Suite 'E2ETests' started",
      "Test Case '-[CallJoinTest testJoinAudioOnly]' passed (4.1 seconds)",
      "Test Case '-[CallJoinTest testJoinWithVideo]' passed (5.3 seconds)",
      "Test Case '-[CallMuteTest testMuteToggle]' passed (2.2 seconds)",
      "Test Case '-[CallReconnectTest testReconnectAfterNetworkDrop]' started",
      "[net] simulating network drop for 8s",
      "[call] state=reconnecting attempt=1",
      "[call] state=reconnecting attempt=2",
      "[call] ICE restart requested",
      "[audio] session interrupted, waiting for route change",
      "[audio] route change not delivered",
      "CallReconnectTest.swift:88: error: -[CallReconnectTest testReconnectAfterNetworkDrop] : XCTAssertTrue failed - timeout waiting for remote audio after reconnect (30.0s)",
      "Test Case '-[CallReconnectTest testReconnectAfterNetworkDrop]' failed (31.2 seconds)",
      "Test Suite 'E2ETests' failed",
      "Executed 41 tests, with 1 failure in 612.4 seconds",
      "ERROR: job e2e-ios failed with exit code 65",
    ],
  },
  "9934": {
    job: "e2e-ios",
    lines: [
      "$ xcodebuild test -scheme E2E -destination 'platform=iOS Simulator,name=iPhone 15,OS=17.2'",
      "Test Suite 'E2ETests' started",
      "Test Case '-[CallJoinTest testJoinAudioOnly]' passed (4.0 seconds)",
      "Test Case '-[CallReconnectTest testReconnectAfterNetworkDrop]' started",
      "[net] simulating network drop for 8s",
      "[audio] session re-activated after interruption",
      "[call] state=connected",
      "[audio] remote stream silent for 30.0s",
      "CallReconnectTest.swift:88: error: -[CallReconnectTest testReconnectAfterNetworkDrop] : XCTAssertTrue failed - timeout waiting for remote audio after reconnect (30.0s)",
      "Test Suite 'E2ETests' failed",
      "Executed 41 tests, with 1 failure in 598.9 seconds",
      "ERROR: job e2e-ios failed with exit code 65",
    ],
  },
};

const MRS = [
  {
    id: "!482",
    title: "Fix call reconnect audio on iOS 17",
    author: "janosch",
    state: "open",
    pipeline: "9934",
    target: "release/7.4",
    ago: 40 * MIN,
  },
  {
    id: "!479",
    title: "Refresh tokens before expiry on resume",
    author: "ana",
    state: "merged",
    pipeline: "9915",
    target: "release/7.4",
    ago: 20 * HOUR,
  },
  {
    id: "!476",
    title: "Update 7.4 upgrade guide",
    author: "vlad",
    state: "open",
    pipeline: "9928",
    target: "main",
    ago: 1 * DAY,
  },
  {
    id: "!470",
    title: "Raft: back off follower catch-up after restart",
    author: "janosch",
    state: "merged",
    pipeline: "9899",
    target: "release/7.4",
    ago: 3 * DAY,
  },
];

const DOCS = [
  {
    id: "doc-node-failover",
    title: "Node failover runbook",
    ago: 12 * DAY,
    body: "Node failover runbook\n\nWhen to use: the raft leader (usually node-1) is unreachable or must be taken out.\n\n1. Check raft_status and confirm which node is leader and the current term.\n2. Drain the leader: run `cluster drain node-1` and wait until clients reconnect.\n3. Stop the leader service. A follower is elected within 10 seconds.\n4. Verify the new leader with `cluster raft status` and check followers are in_sync.\n5. Check database replication lag; promote nothing manually.\n6. Restart the old leader. It rejoins as a follower and catches up.\n\nRollback: if no leader is elected after 30 seconds, restart the node and page the on-call lead.",
  },
  {
    id: "doc-e2ee-architecture",
    title: "E2EE architecture",
    ago: 30 * DAY,
    body: "E2EE architecture\n\nEvery chat has a chat key. Messages are encrypted on the sender's device with the chat key and relayed as ciphertext; servers store and forward only encrypted payloads.\n\nKey distribution: when a device joins, an existing member wraps the chat key to the new device's public key. Removing a member rotates the key (new epoch).\n\nAgents run on a device of their own and read only what they were given after joining. Metadata (chat id, sender device, size, time) is visible to the relay; content is not.",
  },
  {
    id: "doc-node3-disk-cleanup",
    title: "Node-3 disk cleanup runbook",
    ago: 6 * DAY,
    body: "Node-3 disk cleanup runbook\n\nSymptom: disk_pct on node-3 above 80% and growing about 4% per hour.\n\n1. Confirm with metric_trend for node-3 disk_pct.\n2. Rotate and compress logs: `logctl rotate --compress`.\n3. Delete call recordings older than 7 days from /var/data/recordings.\n4. Vacuum the local message cache: `cache vacuum --older-than 14d`.\n5. Re-check disk. Target below 70%.\n\nEscalate when disk passes 90%: the node stops accepting writes.",
  },
  {
    id: "doc-replication-lag",
    title: "Replication lag runbook",
    ago: 9 * DAY,
    body: "Replication lag runbook\n\nSymptom: db-2 lag above 30 seconds and rising. Limit for the test environment is 120 seconds.\n\n1. Check db_sync_status for lag and trend.\n2. Look for long-running transactions on the primary.\n3. Pause the nightly backup if it is running; it competes for IO.\n4. If lag keeps rising, reseed the replica: `db replica reseed db-2`.\n\nAfter reseeding lag should fall to zero within 15 minutes.",
  },
  {
    id: "doc-release-checklist-74",
    title: "7.4 release checklist",
    ago: 2 * DAY,
    body: "7.4 release checklist\n\n- All blocker tickets closed (OPS-1412 call reconnect audio on iOS 17 is open).\n- E2E suite green on release/7.4, including E2E_CallReconnect.\n- Raft follower lag after restart fixed (OPS-1419).\n- Upgrade guide reviewed.\n- Test environment healthy: node-3 disk below 80%, db-2 lag below 30 seconds.\n- Customer sign-off from Northwind Logistics for the 15 Nov go-live.",
  },
  {
    id: "doc-upgrade-guide-74",
    title: "7.4 upgrade guide",
    ago: 1 * DAY,
    body: "7.4 upgrade guide\n\nSupported path: 7.3.x to 7.4.0.\n\n1. Take a backup and confirm it finished.\n2. Upgrade followers one at a time, then the leader (failover first, see the node failover runbook).\n3. Run the schema migration on the primary database.\n4. Upgrade clients; 7.3 clients keep working for 30 days.\n\nKnown issue: calls on iOS 17 may lose audio after a reconnect (OPS-1412) until the fix lands in 7.4.0.",
  },
];

const ACCOUNTS = [
  {
    id: "acc-northwind",
    name: "Northwind Logistics",
    tier: "enterprise",
    arr_eur: 240000,
    owner: "Mira",
    stage: "negotiation",
  },
  {
    id: "acc-helvetia",
    name: "Helvetia Health",
    tier: "growth",
    arr_eur: 96000,
    owner: "Mira",
    stage: "live",
  },
  {
    id: "acc-baltic",
    name: "Baltic Freight",
    tier: "growth",
    arr_eur: 54000,
    owner: "Tomas",
    stage: "evaluation",
  },
];

const DEALS: Record<string, object> = {
  "deal-northwind-74": {
    id: "deal-northwind-74",
    account_id: "acc-northwind",
    name: "Northwind Logistics 7.4 rollout",
    stage: "negotiation",
    amount_eur: 240000,
    target_go_live: "15 Nov",
    depends_on: "release 7.4 (OPS-1412 call reconnect audio on iOS 17)",
    risks: ["7.4 slips past 15 Nov", "iOS drivers rely on call reconnect"],
  },
  "deal-helvetia-renewal": {
    id: "deal-helvetia-renewal",
    account_id: "acc-helvetia",
    name: "Helvetia Health renewal",
    stage: "live",
    amount_eur: 96000,
    target_go_live: null,
    depends_on: null,
    risks: [],
  },
  "deal-baltic-pilot": {
    id: "deal-baltic-pilot",
    account_id: "acc-baltic",
    name: "Baltic Freight pilot",
    stage: "evaluation",
    amount_eur: 54000,
    target_go_live: null,
    depends_on: null,
    risks: ["pilot ends in 3 weeks"],
  },
};

const ACTIVITIES: Record<string, { ago: number; kind: string; summary: string }[]> = {
  "acc-northwind": [
    {
      ago: 1 * DAY,
      kind: "call",
      summary: "Asked for a firm 7.4 date; wants to go live by 15 Nov.",
    },
    { ago: 4 * DAY, kind: "email", summary: "Sent the security questionnaire answers." },
    {
      ago: 8 * DAY,
      kind: "meeting",
      summary: "Demo to their ops team; iOS call quality was the main concern.",
    },
    {
      ago: 15 * DAY,
      kind: "note",
      summary: "Champion is the head of dispatch; legal review starts after go-live date is fixed.",
    },
  ],
  "acc-helvetia": [
    { ago: 6 * DAY, kind: "call", summary: "Quarterly check-in, no issues." },
    { ago: 20 * DAY, kind: "email", summary: "Renewal quote sent." },
  ],
  "acc-baltic": [
    {
      ago: 2 * DAY,
      kind: "meeting",
      summary: "Pilot review: users like the chat, asked about Android calls.",
    },
    { ago: 10 * DAY, kind: "email", summary: "Shared the pilot plan." },
  ],
};

function score(q: string, title: string, body: string): number {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  return words.reduce((s, w) => s + (t.includes(w) ? 3 : 0) + (b.includes(w) ? 1 : 0), 0);
}

export function buildMock(now: () => number) {
  return {
    mergeRequests(state: string) {
      const rows = MRS.filter((m) => state === "all" || m.state === state).map(({ ago, ...m }) => ({
        ...m,
        updated_at: iso(now() - ago),
      }));
      return { merge_requests: rows };
    },
    pipelines(limit: number) {
      return {
        pipelines: PIPELINES.slice(0, limit).map((p) => ({
          id: p.id,
          ref: p.ref,
          status: p.status,
          failed_job: p.failed_job,
          started_at: iso(now() - p.ago),
          duration_s: p.duration_s,
        })),
      };
    },
    pipelineLog(id: string) {
      const p = PIPELINES.find((x) => x.id === id);
      if (!p) return undefined;
      const log = LOGS[id] ?? {
        job: p.failed_job ?? "build",
        lines: ["$ make ci", "all jobs passed"],
      };
      return {
        pipeline: id,
        job: log.job,
        lines: log.lines.slice(-60),
      };
    },
    docsSearch(q: string) {
      const results = DOCS.map((d) => ({ d, s: score(q, d.title, d.body) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 5)
        .map(({ d }) => ({
          id: d.id,
          title: d.title,
          snippet: d.body
            .replace(/\s+/g, " ")
            .slice(d.title.length, d.title.length + 160)
            .trim(),
          updated_at: iso(now() - d.ago),
        }));
      return { results };
    },
    doc(id: string) {
      const d = DOCS.find((x) => x.id === id);
      return d && { id: d.id, title: d.title, updated_at: iso(now() - d.ago), body: d.body };
    },
    accounts(q: string) {
      const needle = q.toLowerCase();
      return {
        accounts: ACCOUNTS.filter(
          (a) => !needle || a.name.toLowerCase().includes(needle) || a.id.includes(needle),
        ),
      };
    },
    deal(id: string) {
      return Object.hasOwn(DEALS, id) ? DEALS[id] : undefined;
    },
    activities(accountId: string) {
      const list = Object.hasOwn(ACTIVITIES, accountId) ? ACTIVITIES[accountId] : undefined;
      return (
        list && {
          activities: list.map((a) => ({
            at: iso(now() - a.ago),
            kind: a.kind,
            summary: a.summary,
          })),
        }
      );
    },
  };
}
