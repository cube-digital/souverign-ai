import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/auth.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createOidcPlugin } from "../src/plugins/oidc.js";
import { type FakeUser, fakeOidc } from "./fake-oidc.js";

const BASE = "https://demo.example";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ENV = {
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csec",
  AUTH_ALLOWED_EMAILS: "ana@example.com,new@example.com",
  PUBLIC_BASE_URL: BASE,
};
const NEW: FakeUser = { sub: "g-new", email: "new@example.com", name: "Newcomer" };
const ANA: FakeUser = { sub: "g-ana", email: "ana@example.com", name: "Ana G" };
const OUT: FakeUser = { sub: "g-out", email: "out@example.org", name: "Out" };

let db: Db;
let t: number;
let fake: Awaited<ReturnType<typeof fakeOidc>>;
let member: [string, string][];

const relayAdmin = { setMember: async () => {} };
function build(env: NodeJS.ProcessEnv = ENV) {
  return buildApp({
    db,
    relayAdmin,
    hooks: {
      onMemberAdded: async (c, u) => {
        member.push([c, u]);
      },
    },
    plugins: [createOidcPlugin({ env, fetch: fake.fetch, now: () => t })],
  });
}
type App = ReturnType<typeof build>;

const tokenCalls = () => fake.calls.filter((c) => c === TOKEN_URL).length;
const cookieOf = (setCookie: unknown) => String(setCookie).split(";")[0] ?? "";

async function start(app: App, extra = "") {
  const r = await app.inject({ method: "GET", url: `/api/auth/oidc/google/start${extra}` });
  const sc = r.headers["set-cookie"];
  return { r, sc: String(sc), cookie: cookieOf(sc), location: String(r.headers.location) };
}
async function callback(app: App, query: string, cookie?: string) {
  return app.inject({
    method: "GET",
    url: `/api/auth/oidc/google/callback?${query}`,
    headers: cookie ? { cookie } : {},
  });
}
async function signIn(app: App, user: FakeUser) {
  const s = await start(app);
  const a = fake.authorize(s.location, user);
  const r = await callback(app, `code=${a.code}&state=${a.state}`, s.cookie);
  return String(r.headers.location);
}
const codeOf = (loc: string) => loc.split("#sa_login=")[1] ?? "";
const exchange = (app: App, code: string) =>
  app.inject({ method: "POST", url: "/api/auth/oidc/exchange", payload: { code } });

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query(
    "insert into sa.users (id, display_name, pin_hash, email) values ('ana', 'Ana', $1, 'ana@example.com')",
    [hashPin("123456")],
  );
  t = Date.now();
  member = [];
  fake = await fakeOidc({ clientId: "cid", clientSecret: "csec" });
});
afterEach(() => db.close());

describe("oidc routes", () => {
  it("disabled: empty provider list, 404 routes, zero outbound fetches", async () => {
    const app = build({});
    const p = await app.inject({ method: "GET", url: "/api/auth/providers" });
    expect(p.json()).toEqual({ pin: true, oidc: [] });
    expect((await start(app)).r.statusCode).toBe(404);
    expect((await callback(app, "code=x&state=y")).statusCode).toBe(404);
    await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { user_id: "ana", pin: "123456" },
    });
    await app.inject({ method: "GET", url: "/api/users" });
    expect(fake.calls).toEqual([]);
  });

  it("enabled: lists google and makes no fetch until the first start", async () => {
    const app = build();
    const p = await app.inject({ method: "GET", url: "/api/auth/providers" });
    expect(p.json()).toEqual({ pin: true, oidc: [{ id: "google", label: "Google" }] });
    expect(fake.calls).toEqual([]);
    await start(app);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it("round trip: fragment-only one-time code, state cookie flags, no other cookies, open redirects ignored", async () => {
    const app = build();
    const s = await start(app, "?return=https://evil.example&redirect=//evil.example&next=/x");
    expect(s.r.statusCode).toBe(302);
    expect(s.sc).toMatch(/HttpOnly/);
    expect(s.sc).toMatch(/SameSite=Lax/);
    expect(s.sc).toMatch(/Secure/);
    expect(s.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(s.location).not.toContain("evil.example");
    const a = fake.authorize(s.location, NEW);
    const cb = await callback(
      app,
      `code=${a.code}&state=${a.state}&return=https://evil.example`,
      s.cookie,
    );
    const loc = String(cb.headers.location);
    expect(loc).toMatch(/^https:\/\/demo\.example\/#sa_login=[^&?#]+$/);
    expect(loc).not.toContain("?");
    const setCookies = [cb.headers["set-cookie"]].flat().map((c) => String(c).split("=")[0]);
    expect(setCookies).toEqual(["sa_oidc"]);

    const ex = await exchange(app, codeOf(loc));
    expect(ex.statusCode).toBe(200);
    expect(ex.headers["set-cookie"]).toBeUndefined();
    const body = ex.json();
    expect(body.user.display_name).toBe("Newcomer");
    const chats = await app.inject({
      method: "GET",
      url: "/api/chats",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(chats.statusCode).toBe(200);
    expect((await exchange(app, codeOf(loc))).statusCode).toBe(401);
  });

  it("a login code is refused after 60 s", async () => {
    const app = build();
    const code = codeOf(await signIn(app, NEW));
    t += 61_000;
    const ex = await exchange(app, code);
    expect(ex.statusCode).toBe(401);
    expect(ex.json()).toEqual({ error: "expired" });
  });

  it("missing, mismatched or replayed state never reaches the token endpoint", async () => {
    const app = build();
    const s1 = await start(app);
    const a1 = fake.authorize(s1.location, NEW);
    const none = await callback(app, `code=${a1.code}&state=${a1.state}`);
    expect(none.headers.location).toBe(`${BASE}/#sa_login_error=expired`);

    const s2 = await start(app);
    const a2 = fake.authorize(s2.location, NEW);
    const other = await callback(app, `code=${a2.code}&state=${a2.state}`, "sa_oidc=wrong-value");
    expect(other.headers.location).toBe(`${BASE}/#sa_login_error=expired`);

    const s3 = await start(app);
    const a3 = fake.authorize(s3.location, NEW);
    const ok = await callback(app, `code=${a3.code}&state=${a3.state}`, s3.cookie);
    expect(String(ok.headers.location)).toContain("#sa_login=");
    expect(tokenCalls()).toBe(1);
    const replay = await callback(app, `code=${a3.code}&state=${a3.state}`, s3.cookie);
    expect(replay.headers.location).toBe(`${BASE}/#sa_login_error=expired`);
    expect(tokenCalls()).toBe(1);
  });

  it("cancelled sign-in returns cancelled; email_verified false and non-allowed emails are refused without creating a user", async () => {
    const app = build();
    const s = await start(app);
    const a = fake.authorize(s.location, NEW);
    const c = await callback(app, `error=access_denied&state=${a.state}`, s.cookie);
    expect(c.headers.location).toBe(`${BASE}/#sa_login_error=cancelled`);

    expect(await signIn(app, OUT)).toBe(`${BASE}/#sa_login_error=not_allowed`);
    expect(await signIn(app, { ...NEW, email_verified: false })).toBe(
      `${BASE}/#sa_login_error=not_allowed`,
    );
    const rows = await db.query<{ id: string }>("select id from sa.users where id <> 'ana'");
    expect(rows).toEqual([]);
  });

  it("PIN login still works and a matching Google email signs in as the existing user", async () => {
    const app = build();
    const pin = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { user_id: "ana", pin: "123456" },
    });
    expect(pin.statusCode).toBe(200);
    const ex = await exchange(app, codeOf(await signIn(app, ANA)));
    expect(ex.json().user.id).toBe("ana");
  });

  it("first sign-in joins seeded rooms only, once, through onMemberAdded", async () => {
    await db.query(
      `insert into sa.chats (id, title, kind, created_by, seed_key, history_until_seq) values
       ('seeded', 'General', 'room', 'ana', 'general', 5),
       ('plain', 'Plain', 'room', 'ana', null, null)`,
    );
    const app = build();
    const ex = await exchange(app, codeOf(await signIn(app, NEW)));
    const id = ex.json().user.id as string;
    const rows = await db.query<{ chat_id: string; removed_at: unknown }>(
      "select chat_id, removed_at from sa.chat_members where member_type = 'user' and member_id = $1",
      [id],
    );
    expect(rows).toEqual([{ chat_id: "seeded", removed_at: null }]);
    expect(member).toEqual([["seeded", id]]);
    await signIn(app, NEW);
    expect(member).toEqual([["seeded", id]]);
  });

  it("PIN picker lists ana but not Google-created users, with Google on and off", async () => {
    const on = build();
    const made = (await exchange(on, codeOf(await signIn(on, NEW)))).json().user.id as string;
    const ids = async (app: App) =>
      (await app.inject({ method: "GET", url: "/api/users" }))
        .json()
        .map((u: { id: string }) => u.id);
    const listedOn = await ids(on);
    expect(listedOn).toContain("ana");
    expect(listedOn).not.toContain(made);
    const listedOff = await ids(build({}));
    expect(listedOff).toContain("ana");
    expect(listedOff).not.toContain(made);
  });
});
