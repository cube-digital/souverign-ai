import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";

async function fixture() {
  const db = await openDb("pglite://memory");
  await migrate(db);
  return db;
}

describe("migration 005", () => {
  it("is additive (PIN users without email still insert), lowercases and uniques emails, links one identity per provider and user", async () => {
    const db = await fixture();
    await db.query("insert into sa.users (id, display_name, pin_hash) values ('u1','U1','x')");
    await db.query("insert into sa.users (id, display_name, pin_hash) values ('u2','U2','x')");
    const rows = await db.query("select id, email from sa.users order by id");
    expect(rows).toEqual([
      { id: "u1", email: null },
      { id: "u2", email: null },
    ]);

    await expect(
      db.query("update sa.users set email = 'A@Example.com' where id = 'u1'"),
    ).rejects.toThrow(/check/i);
    await db.query("update sa.users set email = 'a@example.com' where id = 'u1'");
    await expect(
      db.query("update sa.users set email = 'a@example.com' where id = 'u2'"),
    ).rejects.toThrow(/unique|duplicate/i);

    const ins = (sub: string, user: string) =>
      db.query(
        "insert into sa.identities (provider, subject, user_id, email) values ('google', $1, $2, 'a@example.com')",
        [sub, user],
      );
    await ins("sub-1", "u1");
    await expect(ins("sub-1", "u2")).rejects.toThrow(/unique|duplicate/i);
    await expect(ins("sub-2", "u1")).rejects.toThrow(/unique|duplicate/i);
  });
});
