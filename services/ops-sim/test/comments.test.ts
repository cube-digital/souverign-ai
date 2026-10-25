import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSim } from "../src/server.js";

type Comment = { id: unknown; author: string; body: string; ts: unknown };
type Ticket = { id: string; comments: Comment[] };
let sim: Awaited<ReturnType<typeof createSim>>;
beforeAll(async () => {
  sim = await createSim({ port: 0 });
});
afterAll(() => sim.close());

const post = (path: string, body: unknown) =>
  fetch(sim.url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("ops-sim ticket comments (T9)", () => {
  it("stores a posted comment and returns it with the ticket; unknown tickets are 404", async () => {
    const before = (await (await fetch(`${sim.url}/sim/tickets/OPS-1412`)).json()) as Ticket;
    expect(before.id).toBe("OPS-1412");
    expect(before.comments).toEqual([]);

    const res = await post("/sim/tickets/OPS-1412/comments", {
      author: "Dev Agent",
      body: "Repro confirmed on iOS 17.2.",
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Comment;
    expect(created).toMatchObject({ author: "Dev Agent", body: "Repro confirmed on iOS 17.2." });
    expect(created.id).toBeDefined();
    expect(created.ts).toBeDefined();

    const after = (await (await fetch(`${sim.url}/sim/tickets/OPS-1412`)).json()) as Ticket;
    expect(after.comments).toEqual([created]);

    expect((await fetch(`${sim.url}/sim/tickets/NOPE-1`)).status).toBe(404);
    expect((await post("/sim/tickets/NOPE-1/comments", { author: "x", body: "y" })).status).toBe(
      404,
    );
  });
});
