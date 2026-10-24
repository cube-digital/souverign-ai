import { afterEach, beforeEach, expect, it } from "vitest";
import { createSim } from "../src/server.js";

let sim: Awaited<ReturnType<typeof createSim>>;
beforeEach(async () => {
  sim = await createSim();
});
afterEach(async () => {
  await sim.close();
});

it("rejects non-JSON alert posts and unknown prototype-named ids", async () => {
  const bad = await fetch(`${sim.url}/sim/admin/alerts`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ node: "node-1", severity: "info", message: "x" }),
  });
  expect(bad.status).toBe(415);
  const long = await fetch(`${sim.url}/sim/admin/alerts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node: "node-1", severity: "info", message: "x".repeat(281) }),
  });
  expect(long.status).toBe(400);
  expect((await fetch(`${sim.url}/sim/crm/deals/__proto__`)).status).toBe(404);
  expect((await fetch(`${sim.url}/sim/crm/accounts/constructor/activities`)).status).toBe(404);
});
