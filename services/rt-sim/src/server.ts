import { createServer, type Server } from "node:http";
import { buildSim } from "./data.js";

export interface SimOptions {
  host?: string;
  port?: number;
}

export async function createSim(
  opts: SimOptions = {},
): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const sim = buildSim(Date.now());
  const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const posInt = (v: string | null, dflt: number, max: number) => {
    const n = Number(v ?? dflt);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : dflt;
  };

  const server = createServer((req, res) => {
    const started = Date.now();
    const u = new URL(req.url ?? "/", "http://sim");
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    res.on("finish", () =>
      console.log(
        JSON.stringify({
          level: "info",
          msg: "sim request",
          route: parts[1] ?? "",
          status: res.statusCode,
          ms: Date.now() - started,
        }),
      ),
    );
    if (req.method !== "GET" || parts[0] !== "sim") return send(res, 404, { error: "not_found" });
    const [, a, b = "", c = ""] = parts;
    const q = u.searchParams;
    if (a === "healthz" && !b) return send(res, 200, sim.healthz());
    if (a === "cluster" && b === "health" && !c) return send(res, 200, sim.clusterHealth());
    if (a === "raft" && !b) return send(res, 200, sim.raft());
    if (a === "db" && b === "sync" && !c) return send(res, 200, sim.dbSync());
    if (a === "users" && c === "last-seen") {
      const r = sim.lastSeen(b);
      return r
        ? send(res, 200, r)
        : send(res, 404, { error: "unknown_user", known_users: sim.users });
    }
    if (a === "metrics" && b !== "" && c !== "") {
      const r = sim.metrics(b, c, posInt(q.get("hours"), 6, 72));
      return r
        ? send(res, 200, r)
        : send(res, 404, { error: "unknown_metric", node: b, metric: c });
    }
    if (a === "alerts" && !b) return send(res, 200, sim.alerts(posInt(q.get("hours"), 24, 168)));
    if (a === "qa" && b === "test-runs")
      return send(res, 200, sim.testRuns(posInt(q.get("limit"), 10, 12)));
    if (a === "qa" && b === "flaky") return send(res, 200, sim.flaky());
    if (a === "release" && b === "status") return send(res, 200, sim.release());
    if (a === "tickets" && !b) return send(res, 200, sim.tickets(q.get("status") ?? "open"));
    return send(res, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve),
  );
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    server,
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
