import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import type { IdClaims } from "../src/oidc/client.js";
import type { AllowList } from "../src/oidc/config.js";
import { resolveUser } from "../src/oidc/users.js";

let db: Db;
const allow: AllowList = {
  emails: new Set(["ana@example.com", "g@gmail.com"]),
  domains: new Set(["corp.example"]),
};
const claims = (o: Partial<IdClaims> & { email: string; sub: string }): IdClaims =>
  ({ emailVerified: true, name: "Some Name", ...o }) as IdClaims;

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query(
    "insert into sa.users (id, display_name, pin_hash, email) values ('ana', 'Ana', 'disabled', 'ana@example.com')",
  );
});
afterEach(() => db.close());

describe("resolveUser hardening", () => {
  it("never lets the unauthenticated email domain vouch for a domain allowlist entry", async () => {
    // The email says corp.example but the provider sent no hd claim to check against.
    const r = await resolveUser(
      db,
      "google",
      claims({ sub: "g-1", email: "x@corp.example", domain: "corp.example" }),
      allow,
    );
    expect(r).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("requires the hd claim for allowlisted non-gmail emails, but not for gmail", async () => {
    const mismatch = await resolveUser(
      db,
      "google",
      claims({ sub: "g-2", email: "ana@example.com", domain: "example.org" }),
      allow,
      "hd",
    );
    expect(mismatch).toEqual({ ok: false, reason: "not_allowed" });
    const gmail = await resolveUser(
      db,
      "google",
      claims({ sub: "g-3", email: "g@gmail.com" }),
      allow,
      "hd",
    );
    expect(gmail).toMatchObject({ ok: true, created: true });
  });

  it("refuses an email without a local part even when the hd claim matches", async () => {
    const r = await resolveUser(
      db,
      "google",
      claims({ sub: "g-4", email: "@corp.example", domain: "corp.example" }),
      allow,
      "hd",
    );
    expect(r).toEqual({ ok: false, reason: "not_allowed" });
  });
});
