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
});
