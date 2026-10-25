import type { KnowledgeItem } from "@sa/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { setMemoryForTests } from "../src/memory/client.js";
import { plugin } from "../src/plugins/knowledge.js";
import { approvalsWorld } from "./approvals-fixture.js";
import { FakeMemory } from "./fakes/memory-fake.js";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  setMemoryForTests(undefined);
  for (const c of closers.splice(0)) await c();
});

async function boot() {
  const w = await approvalsWorld();
  setMemoryForTests(new FakeMemory());
  const app = buildApp({
    db: w.db,
    relayAdmin: { setMember: async () => {} },
    agentHost: w.host,
    plugins: [plugin],
  });
  closers.push(() => app.close());
  await app.ready();
  return (agent: string, token: string | null, name: string, bytes: Buffer) =>
    app.inject({
      method: "POST",
      url: `/api/agents/${agent}/knowledge`,
      headers: {
        ...(token ? { authorization: `Bearer tok-${token}` } : {}),
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-file-type": "text/plain",
      },
      payload: bytes,
    });
}

describe("upload auth and names", () => {
  it("rejects unauthenticated and unauthorized callers before the oversized body is read", async () => {
    const post = await boot();
    const big = Buffer.alloc(21 * 1024 * 1024, 97);
    expect((await post("max", null, "a.txt", big)).statusCode).toBe(401);
    expect((await post("nora", "bob", "a.txt", big)).statusCode).toBe(404);
  });

  it("strips control characters from the stored title", async () => {
    const post = await boot();
    const r = await post("max", "bob", " a\u0001b‮.txt ", Buffer.from("hello"));
    expect(r.statusCode).toBe(200);
    expect((r.json() as KnowledgeItem).title).toBe("ab.txt");
    expect((await post("max", "bob", "..", Buffer.from("x"))).statusCode).toBe(400);
  });
});
