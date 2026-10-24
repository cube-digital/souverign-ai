import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { startAlertWatch } from "../src/proactive/alert-watch.js";

it("posts nothing until a baseline exists, then treats active alerts as seen", async () => {
  const db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ('u','U','x')");
  await db.query(
    "insert into sa.agents (id, name, template, scope, roster_id) values ('ag-ops','Ops','ops','workspace','ops')",
  );
  await db.query(
    "insert into sa.chats (id, title, kind, created_by, seed_key) values ('c-ops','ops','room','u','ops')",
  );
  let down = true;
  const alert = { at: "t", severity: "critical", node: "n", message: "m" };
  const sim = createServer((_q, res) => {
    if (down) {
      res.statusCode = 500;
      res.end("{}");
    } else res.end(JSON.stringify({ alerts: [alert] }));
  });
  await new Promise<void>((r) => sim.listen(0, "127.0.0.1", r));
  const calls: unknown[] = [];
  const w = await startAlertWatch({
    db,
    relayAdmin: { setMember: async () => {} },
    relayInternalUrl: "",
    ticketFor: async () => "t",
    opsSimUrl: `http://127.0.0.1:${(sim.address() as AddressInfo).port}`,
    agentHost: {
      onAgentAdded: async () => {},
      onAgentRemoved: async () => {},
      runProactive: async (r) => {
        calls.push(r);
        return true;
      },
    },
    log: () => {},
  });
  await w.tick();
  expect(calls).toEqual([]);
  down = false;
  await w.tick(); // baseline now, no post
  await w.tick();
  expect(calls).toEqual([]);
  w.stop();
  sim.close();
  await db.close();
});
