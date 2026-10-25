import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPin } from "../src/auth.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import type { IdClaims } from "../src/oidc/client.js";
import type { AllowList } from "../src/oidc/config.js";
import { resolveUser } from "../src/oidc/users.js";

let db: Db;
const allow: AllowList = {
  emails: new Set(["ana@example.com", "new@example.com", "mira@example.com"]),
  domains: new Set(["corp.example"]),
};
const claims = (o: Partial<IdClaims> & { email: string; sub: string }): IdClaims =>
  ({ emailVerified: true, name: "Some Name", ...o }) as IdClaims;
const userCount = async () =>
  Number((await db.query<{ n: string }>("select count(*) as n from sa.users"))[0]?.n);

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query(
    "insert into sa.users (id, display_name, pin_hash, email) values ('ana', 'Ana', $1, 'ana@example.com')",
    [hashPin("123456")],
  );
  await db.query(
    "insert into sa.users (id, display_name, pin_hash, email, kind) values ('mira', 'Mira', 'disabled', 'mira@example.com', 'seed')",
  );
});
afterEach(() => db.close());

describe("resolveUser", () => {
  it("creates a user on first login of an allowed verified email and reuses it for the same sub", async () => {
    const c = claims({ sub: "g-new", email: "new@example.com", name: "Newbie" });
    const first = await resolveUser(db, "google", c, allow);
    expect(first).toMatchObject({ ok: true, created: true, displayName: "Newbie" });
    if (!first.ok) throw new Error("unreachable");
    expect(first.userId).toMatch(/^u_/);
    expect(await resolveUser(db, "google", c, allow)).toEqual({
      ok: true,
      userId: first.userId,
      displayName: "Newbie",
      created: false,
    });
    expect(await userCount()).toBe(3);
  });

  it("links an existing person by email instead of creating a user", async () => {
    const r = await resolveUser(
      db,
      "google",
      claims({ sub: "g-ana", email: "ana@example.com" }),
      allow,
    );
    expect(r).toEqual({ ok: true, userId: "ana", displayName: "Ana", created: false });
    expect(await userCount()).toBe(2);
  });

  it("refuses a second subject for an already linked email as conflict", async () => {
    await resolveUser(db, "google", claims({ sub: "g-ana", email: "ana@example.com" }), allow);
    const r = await resolveUser(
      db,
      "google",
      claims({ sub: "g-other", email: "ana@example.com" }),
      allow,
    );
    expect(r).toEqual({ ok: false, reason: "conflict" });
  });

  it("refuses an unverified email", async () => {
    const r = await resolveUser(
      db,
      "google",
      claims({ sub: "g-1", email: "new@example.com", emailVerified: false }),
      allow,
    );
    expect(r).toEqual({ ok: false, reason: "not_allowed" });
    expect(await userCount()).toBe(2);
  });

  it("refuses an email that is not allowed", async () => {
    const r = await resolveUser(
      db,
      "google",
      claims({ sub: "g-2", email: "out@example.org" }),
      allow,
    );
    expect(r).toEqual({ ok: false, reason: "not_allowed" });
    expect(await userCount()).toBe(2);
  });

  it("requires the hd claim for domain allowlist when a domain claim is in use", async () => {
    const noHd = await resolveUser(
      db,
      "google",
      claims({ sub: "g-3", email: "x@corp.example" }),
      allow,
      "hd",
    );
    expect(noHd).toEqual({ ok: false, reason: "not_allowed" });
    const withHd = await resolveUser(
      db,
      "google",
      claims({
        sub: "g-3",
        email: "x@corp.example",
        domain: "corp.example",
      } as Partial<IdClaims> & {
        email: string;
        sub: string;
      }),
      allow,
      "hd",
    );
    expect(withHd).toMatchObject({ ok: true, created: true });
  });

  it("never logs in a seed colleague, and refuses a linked user removed from the allowlist", async () => {
    const mira = await resolveUser(
      db,
      "google",
      claims({ sub: "g-m", email: "mira@example.com" }),
      allow,
    );
    expect(mira).toEqual({ ok: false, reason: "not_allowed" });
    const c = claims({ sub: "g-ana", email: "ana@example.com" });
    expect(await resolveUser(db, "google", c, allow)).toMatchObject({ ok: true, userId: "ana" });
    const narrowed: AllowList = { emails: new Set(["new@example.com"]), domains: new Set() };
    expect(await resolveUser(db, "google", c, narrowed)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
  });
});
