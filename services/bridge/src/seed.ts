import { randomInt } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPin } from "./auth.js";
import { openDb } from "./db.js";
import { migrate } from "./migrate.js";
import { parseDemoEmails } from "./oidc/config.js";

const USERS = [
  ["ana", "Ana"],
  ["vlad", "Vlad"],
  ["rares", "Rareș"],
  ["janosch", "Janosch"],
] as const;

const db = await openDb();
await migrate(db);

const given = new Map(
  (process.env.SA_DEMO_PINS || "")
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
    // Only person rows get a PIN; a demo colleague (kind = 'seed') with this id is left alone.
    const updated = await db.query(
      `insert into sa.users (id, display_name, pin_hash) values ($1, $2, $3)
       on conflict (id) do update set display_name = excluded.display_name, pin_hash = excluded.pin_hash
       where sa.users.kind = 'person' returning id`,
      [id, name, hashPin(pin)],
    );
    if (updated.length > 0) set.push(`${id}:${pin}`);
  } else {
    await db.query("update sa.users set display_name = $2 where id = $1 and kind = 'person'", [
      id,
      name,
    ]);
  }
}
for (const [id, email] of parseDemoEmails(process.env.SA_DEMO_EMAILS)) {
  const linked = await db.query(
    "update sa.users set email = $2 where id = $1 and kind = 'person' returning id",
    [id, email],
  );
  if (linked.length > 0) console.log(`demo email linked: ${id}`);
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
