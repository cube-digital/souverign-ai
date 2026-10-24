import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSim } from "../src/server.js";

let sim: Awaited<ReturnType<typeof createSim>>;
beforeAll(async () => {
  sim = await createSim({ port: 0 });
});
afterAll(() => sim.close());
const get = async (path: string) => {
  const r = await fetch(sim.url + path);
  return { status: r.status, body: (await r.json()) as any };
};

describe("ops-sim", () => {
  it("node-3 disk rises ~4.1 per hour and its latest point matches cluster health", async () => {
    const series = (await get("/sim/metrics/node-3/disk_pct?hours=6")).body.points as {
      value: number;
    }[];
    const health = (await get("/sim/cluster/health")).body.nodes.find(
      (n: any) => n.node === "node-3",
    );
    const last = series.at(-1)?.value ?? Number.NaN;
    expect(Math.abs(last - health.disk_pct)).toBeLessThan(0.1);
    for (let i = 1; i < series.length; i++) {
      const step = (series[i]?.value ?? 0) - (series[i - 1]?.value ?? 0);
      expect(step).toBeGreaterThan(3.9);
      expect(step).toBeLessThan(4.3);
    }
    expect(health.disk_growth_pct_per_h).toBe(4.1);
  });

  it("reports unknown users and metrics instead of inventing them", async () => {
    const u = await get("/sim/users/nobody/last-seen");
    expect(u.status).toBe(404);
    expect(u.body.error).toBe("unknown_user");
    expect(u.body.known_users).toEqual(["janosch", "ana", "vlad"]);
    expect((await get("/sim/metrics/node-9/disk_pct")).status).toBe(404);
    expect((await get("/sim/metrics/node-1/bogus")).status).toBe(404);
  });

  it("tells one 7.4 story across dev, docs and crm data", async () => {
    const mrs = (await get("/sim/dev/merge-requests?state=open")).body.merge_requests as any[];
    const mr = mrs.find((m) => m.title === "Fix call reconnect audio on iOS 17");
    expect(String(mr.id)).toMatch(/482$/);
    expect(mr.target).toBe("release/7.4");

    const pipes = (await get("/sim/dev/pipelines?limit=10")).body.pipelines as any[];
    const nightly = pipes.find((p) => String(p.id).endsWith("9921"));
    expect(nightly.status).toBe("failed");
    expect(nightly.failed_job).toBe("e2e-ios");
    const log = (await get(`/sim/dev/pipelines/${nightly.id}/log`)).body;
    expect(log.job).toBe("e2e-ios");
    expect(log.lines.length).toBeLessThanOrEqual(60);
    expect(log.lines.join("\n")).toContain("CallReconnectTest.swift:88");
    expect((await get("/sim/dev/pipelines/0000/log")).status).toBe(404);

    const hits = (await get("/sim/docs/search?q=failover")).body.results as any[];
    expect(hits[0].title).toMatch(/failover/i);
    const doc = (await get(`/sim/docs/${hits[0].id}`)).body;
    expect(doc.id).toBe(hits[0].id);
    expect(doc.body.length).toBeGreaterThan(0);
    expect((await get("/sim/docs/no-such-doc")).status).toBe(404);

    const accounts = (await get("/sim/crm/accounts?q=northwind")).body.accounts as any[];
    expect(accounts.map((a) => a.id)).toEqual(["acc-northwind"]);
    const acts = (await get("/sim/crm/accounts/acc-northwind/activities")).body.activities;
    expect(acts.length).toBeGreaterThan(0);
    expect(Object.keys(acts[0]).sort()).toEqual(["at", "kind", "summary"]);
  });

  it("lets a demo raise an alert that then shows up in /sim/alerts under the returned id", async () => {
    const r = await fetch(`${sim.url}/sim/admin/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "node-3", severity: "critical", message: "Disk almost full" }),
    });
    const { id } = (await r.json()) as { id: string };
    expect(id).toMatch(/^node-3:/);
    const list = (await get("/sim/alerts")).body.alerts as any[];
    expect(list.find((a) => a.id === id)).toMatchObject({
      node: "node-3",
      severity: "critical",
      message: "Disk almost full",
    });
  });
});
