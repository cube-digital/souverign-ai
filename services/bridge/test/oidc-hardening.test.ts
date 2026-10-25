import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createOidcPlugin } from "../src/plugins/oidc.js";
import { fakeOidc } from "./fake-oidc.js";

const ENV = {
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csec",
  AUTH_ALLOWED_EMAILS: "new@example.com",
  PUBLIC_BASE_URL: "https://demo.example",
};
let db: Db;
let fake: Awaited<ReturnType<typeof fakeOidc>>;
const build = () =>
  buildApp({
    db,
    relayAdmin: { setMember: async () => {} },
    plugins: [createOidcPlugin({ env: ENV, fetch: fake.fetch })],
  });
const start = (app: ReturnType<typeof build>, path = "/api/auth/oidc/google/start") =>
  app.inject({ method: "GET", url: path });

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  fake = await fakeOidc({ clientId: "cid", clientSecret: "csec" });
});
afterEach(() => db.close());

describe("oidc hardening", () => {
  it("the rate limit also covers percent-encoded paths", async () => {
    const app = build();
    let last = 0;
    for (let i = 0; i < 70; i++)
      last = (await start(app, "/api/auth/oidc/%67oogle/start")).statusCode;
    expect(last).toBe(429);
  });

  it("many started flows from one client never lock out a new start", async () => {
    const app = build();
    for (let i = 0; i < 25; i++) {
      const r = await start(app);
      expect(String(r.headers.location)).toMatch(/^https:\/\/accounts\.google\.com\//);
    }
  });

  it("a later login re-joins seeded rooms the user is missing, without duplicates", async () => {
    await db.query(
      `insert into sa.users (id, display_name, pin_hash) values ('boss', 'Boss', 'disabled');
       insert into sa.chats (id, title, kind, created_by, seed_key, history_until_seq)
       values ('s1', 'General', 'room', 'boss', 'general', 5)`,
    );
    const app = build();
    const login = async () => {
      const s = await start(app);
      const a = fake.authorize(String(s.headers.location), {
        sub: "g1",
        email: "new@example.com",
      });
      const cookie = String(s.headers["set-cookie"]).split(";")[0] ?? "";
      return app.inject({
        method: "GET",
        url: `/api/auth/oidc/google/callback?code=${a.code}&state=${a.state}`,
        headers: { cookie },
      });
    };
    await login();
    await db.query("delete from sa.chat_members where member_type = 'user' and chat_id = 's1'");
    await login();
    const rows = await db.query(
      "select 1 from sa.chat_members where chat_id = 's1' and member_type = 'user'",
    );
    expect(rows).toHaveLength(1);
  });
});
