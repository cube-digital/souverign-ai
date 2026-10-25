import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import type { IdClaims } from "./client.js";
import type { AllowList } from "./config.js";

export type Resolved =
  | { ok: true; userId: string; displayName: string; created: boolean }
  | { ok: false; reason: "not_allowed" | "conflict" };
type UserRow = { id: string; display_name: string; kind: string };

export function isAllowed(c: IdClaims, allow: AllowList, domainClaim?: string): boolean {
  if (!c.emailVerified) return false;
  if (allow.emails.has(c.email)) return true;
  const domain = c.email.slice(c.email.lastIndexOf("@") + 1);
  if (!domain || !allow.domains.has(domain)) return false;
  return domainClaim ? c.domain === domain : true;
}

export function displayName(c: IdClaims): string {
  const clean = (c.name ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, 80);
  return clean || (c.email.split("@")[0] ?? "user").slice(0, 80);
}

export async function resolveUser(
  db: Db,
  provider: string,
  c: IdClaims,
  allow: AllowList,
  domainClaim?: string,
): Promise<Resolved> {
  if (!isAllowed(c, allow, domainClaim)) return { ok: false, reason: "not_allowed" };
  const [known] = await db.query<UserRow>(
    `select u.id, u.display_name, u.kind from sa.identities i join sa.users u on u.id = i.user_id
     where i.provider = $1 and i.subject = $2`,
    [provider, c.sub],
  );
  if (known) {
    if (known.kind !== "person") return { ok: false, reason: "not_allowed" };
    await db.query(
      "update sa.identities set email = $3, last_login_at = now() where provider = $1 and subject = $2",
      [provider, c.sub, c.email],
    );
    return { ok: true, userId: known.id, displayName: known.display_name, created: false };
  }
  const byEmail = () =>
    db.query<UserRow>("select id, display_name, kind from sa.users where email = $1", [c.email]);
  let created = false;
  let [u] = await byEmail();
  if (!u) {
    const rows = await db.query<UserRow>(
      `insert into sa.users (id, display_name, pin_hash, email) values ($1, $2, 'disabled', $3)
       on conflict do nothing returning id, display_name, kind`,
      [`u_${randomBytes(8).toString("hex")}`, displayName(c), c.email],
    );
    created = rows.length > 0;
    [u] = created ? rows : await byEmail();
  }
  if (!u || u.kind !== "person") return { ok: false, reason: "not_allowed" };
  const linked = await db.query(
    `insert into sa.identities (provider, subject, user_id, email) values ($1, $2, $3, $4)
     on conflict do nothing returning user_id`,
    [provider, c.sub, u.id, c.email],
  );
  if (linked.length === 0) {
    const [again] = await db.query<{ user_id: string }>(
      "select user_id from sa.identities where provider = $1 and subject = $2",
      [provider, c.sub],
    );
    if (again?.user_id !== u.id) return { ok: false, reason: "conflict" };
  }
  return { ok: true, userId: u.id, displayName: u.display_name, created };
}
