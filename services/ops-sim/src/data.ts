import { buildMock } from "./mock.js";

// Synthetic ops data, computed relative to a start time so it always looks live.
const MIN = 60_000;
const HOUR = 3_600_000;

export const NODES = ["node-1", "node-2", "node-3"] as const;
export const METRICS = ["cpu_pct", "mem_pct", "disk_pct", "p95_latency_ms"] as const;
export type Metric = (typeof METRICS)[number];

const iso = (ms: number) => new Date(ms).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;

const DISK_NOW: Record<string, number> = { "node-1": 52, "node-2": 47, "node-3": 81 };
const DISK_GROWTH: Record<string, number> = { "node-1": 0.2, "node-2": 0.1, "node-3": 4.1 };
const BASE: Record<string, Record<string, number>> = {
  "node-1": { cpu_pct: 38, mem_pct: 61, p95_latency_ms: 42 },
  "node-2": { cpu_pct: 29, mem_pct: 55, p95_latency_ms: 47 },
  "node-3": { cpu_pct: 44, mem_pct: 68, p95_latency_ms: 63 },
};
const ROLES: Record<string, string> = {
  "node-1": "leader",
  "node-2": "follower",
  "node-3": "follower",
};

function diskPct(node: string, hoursAgo: number): number {
  return round1((DISK_NOW[node] ?? 0) - (DISK_GROWTH[node] ?? 0) * hoursAgo);
}

function statusOf(disk: number): string {
  return disk >= 90 ? "critical" : disk >= 75 ? "warning" : "ok";
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function buildSim(start: number) {
  const now = () => Date.now();
  // Elapsed time since start (modulo 1 hour, a rolling anchor so disk never passes ~90%) drifts the scenario; stays consistent across routes.
  const drift = () => ((now() - start) % HOUR) / HOUR;
  const diskAt = (node: string, hoursAgo: number) =>
    round1(diskPct(node, hoursAgo) + (DISK_GROWTH[node] ?? 0) * drift());

  function metricValue(node: string, metric: Metric, hoursAgo: number): number {
    if (metric === "disk_pct") return diskAt(node, hoursAgo);
    const base = BASE[node]?.[metric] ?? 0;
    const wobble =
      Math.sin((hoursAgo + node.length * 3) * 1.3) * (metric === "p95_latency_ms" ? 4 : 3);
    return round1(base + wobble);
  }

  const raised: { at: number; severity: string; node: string; message: string }[] = [];
  const mock = buildMock(now);
  const comments = new Map<string, { id: string; author: string; body: string; ts: number }[]>();
  const allTickets = () => {
    const t = now();
    return [
      {
        id: "OPS-1412",
        title: "Call reconnect drops audio on iOS 17",
        severity: "blocker",
        status: "open",
        opened_at: iso(t - 5 * 24 * HOUR),
      },
      {
        id: "OPS-1419",
        title: "Raft follower lag after restart",
        severity: "major",
        status: "open",
        opened_at: iso(t - 2 * 24 * HOUR),
      },
      {
        id: "OPS-1423",
        title: "Docs: update upgrade guide for 7.4",
        severity: "minor",
        status: "open",
        opened_at: iso(t - 1 * 24 * HOUR),
      },
    ];
  };

  return {
    ...mock,
    raiseAlert(node: string, severity: string, message: string): { id: string } {
      raised.push({ at: now(), severity, node, message });
      if (raised.length > 50) raised.shift();
      return { id: `${node}:${slug(message)}` };
    },
    healthz: () => ({ ok: true, service: "ops-sim", uptime_s: Math.round((now() - start) / 1000) }),

    clusterHealth() {
      return {
        nodes: NODES.map((node) => {
          const disk = metricValue(node, "disk_pct", 0);
          return {
            node,
            role: ROLES[node],
            cpu_pct: metricValue(node, "cpu_pct", 0),
            mem_pct: metricValue(node, "mem_pct", 0),
            disk_pct: disk,
            disk_growth_pct_per_h: DISK_GROWTH[node],
            p95_latency_ms: metricValue(node, "p95_latency_ms", 0),
            status: statusOf(disk),
          };
        }),
      };
    },

    raft() {
      return {
        leader: "node-1",
        term: 12,
        last_election_at: iso(start - 3.1 * HOUR),
        last_election_reason: "node-2 restarted",
        followers: [
          { node: "node-2", match_index_lag: 0, state: "in_sync" },
          { node: "node-3", match_index_lag: 37, state: "catching_up" },
        ],
      };
    },

    dbSync() {
      return {
        primary: "db-1",
        replicas: [
          {
            replica: "db-2",
            state: "lagging",
            lag_seconds: 45 + Math.round(18 * drift()),
            lag_trend_seconds_per_hour: 18,
            last_sync_at: iso(now() - 45 * 1000),
          },
          {
            replica: "db-3",
            state: "healthy",
            lag_seconds: 0,
            lag_trend_seconds_per_hour: 0,
            last_sync_at: iso(now() - 2000),
          },
        ],
      };
    },

    users: ["janosch", "ana", "vlad"],
    lastSeen(username: string) {
      const t = now();
      const users: Record<string, object> = {
        janosch: {
          last_seen_at: iso(t - 12 * MIN),
          client: "macOS app",
          version: "7.4.0-rc2",
          region: "CH",
        },
        ana: {
          last_seen_at: iso(t - (2 * 60 + 5) * MIN),
          client: "iOS",
          version: "7.3.2",
          region: "RO",
        },
        vlad: {
          last_seen_at: iso(t - 3 * 24 * HOUR),
          client: "Android",
          version: "7.3.1",
          region: "RO",
        },
      };
      return users[username] ? { username, ...users[username] } : undefined;
    },

    metrics(node: string, metric: string, hours: number) {
      if (
        !(NODES as readonly string[]).includes(node) ||
        !(METRICS as readonly string[]).includes(metric)
      ) {
        return undefined;
      }
      const points = [];
      for (let h = hours; h >= 0; h--) {
        points.push({ at: iso(now() - h * HOUR), value: metricValue(node, metric as Metric, h) });
      }
      return { node, metric, hours, points };
    },

    alerts(hours: number) {
      const t = now();
      const all = [
        {
          at: iso(t - 20 * MIN),
          severity: "warning",
          node: "node-3",
          message: "disk usage above 80%",
        },
        {
          at: iso(t - 55 * MIN),
          severity: "warning",
          node: "db-2",
          message: "replication lag above 30 s",
        },
        {
          at: iso(t - 3.1 * HOUR),
          severity: "info",
          node: "node-2",
          message: "node restarted, leader re-elected",
        },
        {
          at: iso(t - 3.0 * HOUR),
          severity: "warning",
          node: "node-3",
          message: "raft follower lagging after election",
        },
        {
          at: iso(t - 9 * HOUR),
          severity: "info",
          node: "node-1",
          message: "nightly backup finished",
        },
        {
          at: iso(t - 30 * HOUR),
          severity: "info",
          node: "node-2",
          message: "certificate renewed",
        },
      ];
      const withIds = [...all, ...raised.map((r) => ({ ...r, at: iso(r.at) }))]
        .map((a) => ({ id: `${a.node}:${slug(a.message)}`, ...a }))
        .sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
      return { hours, alerts: withIds.filter((a) => Date.parse(a.at) >= t - hours * HOUR) };
    },

    testRuns(limit: number) {
      const t = now();
      // newest first; E2E_CallReconnect fails in 3 of the last 5 runs.
      const runs = Array.from({ length: 12 }, (_, i) => {
        const reconnectFails = i < 5 ? [true, false, true, false, true][i] === true : i % 4 === 0;
        const otherFail = i === 3 ? ["API_TokenRefresh"] : [];
        const failed_tests = [...(reconnectFails ? ["E2E_CallReconnect"] : []), ...otherFail];
        return {
          id: `run-${2048 - i}`,
          version: "7.4.0-rc2",
          started_at: iso(t - (i * 5 + 2) * HOUR),
          passed: 412 - failed_tests.length,
          failed: failed_tests.length,
          failed_tests,
        };
      });
      return { runs: runs.slice(0, limit) };
    },

    flaky() {
      const t = now();
      return {
        tests: [
          { test: "E2E_CallReconnect", failure_rate: 0.6, first_seen_at: iso(t - 6 * 24 * HOUR) },
          { test: "API_TokenRefresh", failure_rate: 0.1, first_seen_at: iso(t - 14 * 24 * HOUR) },
          { test: "UI_ThemeSwitch", failure_rate: 0.05, first_seen_at: iso(t - 30 * 24 * HOUR) },
        ],
      };
    },

    release() {
      return {
        version: "7.4.0-rc2",
        ready: false,
        blockers: [
          { id: "OPS-1412", title: "Call reconnect drops audio on iOS 17", severity: "blocker" },
          { id: "OPS-1419", title: "Raft follower lag after restart", severity: "major" },
        ],
      };
    },

    ticket(id: string) {
      const found = allTickets().find((x) => x.id === id);
      return found && { ...found, comments: [...(comments.get(id) ?? [])] };
    },
    addComment(id: string, author: string, body: string) {
      if (!allTickets().some((x) => x.id === id)) return undefined;
      const list = comments.get(id) ?? [];
      if (list.length >= 200) return null;
      const c = { id: `${id}-c${list.length + 1}`, author, body, ts: now() };
      comments.set(id, [...list, c]);
      return c;
    },
    tickets(status: string) {
      const all = allTickets();
      return { status, tickets: all.filter((x) => x.status === status) };
    },
  };
}
