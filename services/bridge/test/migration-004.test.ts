import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";

async function fixture() {
  const db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ('u','U','x')");
  await db.query(
    "insert into sa.agents (id, name, template, scope, roster_id) values ('ag','Ops','ops','workspace','ops')",
  );
  await db.query(
    "insert into sa.chats (id, title, kind, created_by, seed_key) values ('c','ops','room','u','ops')",
  );
  return db;
}

const insertApproval = (
  db: Awaited<ReturnType<typeof fixture>>,
  tool: string,
  status: string,
  decided: string,
) =>
  db.query(
    `insert into sa.approvals (id, agent_id, chat_id, kind, tool, args, preview, status, approver_user_id, decided_at, expires_at)
     values ('a1','ag','c','tool',$1,'{}','{}',$2,'u',${decided},now())`,
    [tool, status],
  );

describe("migration 004", () => {
  it("defaults share_private_in_chats to always and rejects other values", async () => {
    const db = await fixture();
    const r = await db.query("select share_private_in_chats as p from sa.agents where id = 'ag'");
    expect(r.rows[0]).toEqual({ p: "always" });
    await expect(
      db.query("update sa.agents set share_private_in_chats = 'sometimes' where id = 'ag'"),
    ).rejects.toThrow(/check/i);
  });

  it("rejects pending approvals with a decision time and accepts any registered tool name", async () => {
    const db = await fixture();
    await expect(insertApproval(db, "notes_publish", "pending", "now()")).rejects.toThrow(/check/i);
    await insertApproval(db, "call_notes_publish", "pending", "null");
    const r = await db.query("select tool, status from sa.approvals where id = 'a1'");
    expect(r.rows[0]).toEqual({ tool: "call_notes_publish", status: "pending" });
  });

  it("stores ask_user questions with a bounded status", async () => {
    const db = await fixture();
    const ins = (status: string) =>
      db.query(
        `insert into sa.questions (id, agent_id, chat_id, requester_user_id, question, status, expires_at)
         values ('q1','ag','c','u','Which?',$1,now())`,
        [status],
      );
    await expect(ins("maybe")).rejects.toThrow(/check/i);
    await ins("open");
    const r = await db.query("select status, options from sa.questions where id = 'q1'");
    expect(r.rows[0]).toEqual({ status: "open", options: [] });
  });
});
