import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesRuntime } from "../src/agents/hermes.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";

let db: Db;
beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ('ana','Ana','x')");
});
afterEach(() => db.close());

describe("hermes port allocation", () => {
  it("gives concurrently pre-warmed agents distinct ports within 8701-8709", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `agent-${i}-00000000`);
    for (const id of ids) {
      await db.query(
        "insert into sa.agents (id, owner_user_id, name, template) values ($1,'ana',$1,'qa')",
        [id],
      );
    }
    const rt = new HermesRuntime({ db }) as unknown as {
      allocatePort(id: string): Promise<number>;
    };
    const ports = await Promise.all(ids.map((id) => rt.allocatePort(id)));
    expect(new Set(ports).size).toBe(ids.length);
    for (const p of ports) expect(p).toBeGreaterThanOrEqual(8701);
    for (const p of ports) expect(p).toBeLessThanOrEqual(8709);
  });
});
