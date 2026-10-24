import { randomInt } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPin } from "./auth.js";
import { openDb } from "./db.js";
import { migrate } from "./migrate.js";

const USERS = [
  ["ana", "Ana"],
  ["vlad", "Vlad"],
  ["rares", "Rareș"],
  ["janosch", "Janosch"],
] as const;

const db = await openDb();
await migrate(db);

const given = new Map(
  (process.env.SA_DEMO_PINS ?? "")
    .split(",")
    .map((p) => p.trim().split(":") as [string, string])
    .filter(([id, pin]) => id && pin),
);
const set: string[] = [];
for (const [id, name] of USERS) {
  const [existing] = await db.query<{ id: string }>("select id from sa.users where id = $1", [id]);
  let pin = given.get(id);
  if (!pin && !existing) pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
  if (pin) {
    await db.query(
      `insert into sa.users (id, display_name, pin_hash) values ($1, $2, $3)
       on conflict (id) do update set display_name = excluded.display_name, pin_hash = excluded.pin_hash`,
      [id, name, hashPin(pin)],
    );
    set.push(`${id}:${pin}`);
  } else {
    await db.query("update sa.users set display_name = $2 where id = $1", [id, name]);
  }
}
await db.close();

if (set.length > 0) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const file = join(root, ".run", "demo-pins.txt");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${set.join("\n")}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(set.join("\n"));
}
