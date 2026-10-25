import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import type { IdClaims } from "./client.js";
import type { AllowList } from "./config.js";

export type Resolved =
  | { ok: true; userId: string; displayName: string; created: boolean }
  | { ok: false; reason: "not_allowed" | "conflict" };
type UserRow = { id: string; display_name: string; kind: string };

// Consumer mail domains do not share one hosted-domain claim, so the hd check does not apply to them.
const GENERIC_MAIL = new Set(["gmail.com", "googlemail.com"]);

export function isAllowed(c: IdClaims, allow: AllowList, domainClaim?: string): boolean {
  if (!c.emailVerified) return false;
  const at = c.email.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = c.email.slice(at + 1);
  if (!domain) return false;
  // Only the verified domain claim may vouch for a domain; the email's own domain never does.
  const hdMatches = !!domainClaim && c.domain === domain;
  if (allow.emails.has(c.email)) return !domainClaim || GENERIC_MAIL.has(domain) || hdMatches;
  if (!allow.domains.has(domain)) return false;
  return hdMatches;
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
  let [u] = await byEmail();
  if (!u) {
    // One statement: the user and its identity link commit together or not at all.
    // If the sub is already linked elsewhere, the identity insert fails and nothing is kept.
    let rows: UserRow[];
    try {
      rows = await db.query<UserRow>(
        `with new_user as (
           insert into sa.users (id, display_name, pin_hash, email) values ($1, $2, 'disabled', $3)
           on conflict do nothing returning id, display_name, kind
         ), new_link as (
           insert into sa.identities (provider, subject, user_id, email)
           select $4, $5, new_user.id, $3 from new_user
           returning user_id
         )
         select new_user.id, new_user.display_name, new_user.kind from new_user
         where exists (select 1 from new_link)`,
        [`u_${randomBytes(8).toString("hex")}`, displayName(c), c.email, provider, c.sub],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return { ok: false, reason: "conflict" };
      throw err;
    }
    if (rows[0]) {
      return { ok: true, userId: rows[0].id, displayName: rows[0].display_name, created: true };
    }
    [u] = await byEmail();
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
  return { ok: true, userId: u.id, displayName: u.display_name, created: false };
}
