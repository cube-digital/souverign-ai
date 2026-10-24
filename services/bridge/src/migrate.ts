import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Db, openDb } from "./db.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(db: Db): Promise<void> {
  await db.query("create schema if not exists sa");
  await db.query(
    "create table if not exists sa.schema_migrations (version text primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set(
    (await db.query<{ version: string }>("select version from sa.schema_migrations")).map(
      (r) => r.version,
    ),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (done.has(file)) continue;
    await db.query(readFileSync(join(dir, file), "utf8"));
    await db.query("insert into sa.schema_migrations (version) values ($1)", [file]);
    console.log(JSON.stringify({ level: "info", msg: "migration applied", version: file }));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = await openDb();
  await migrate(db);
  await db.close();
}
