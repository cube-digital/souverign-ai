import { describe, expect, it } from "vitest";
import { loadAuthConfig, parseDemoEmails } from "../src/oidc/config.js";

const SECRET = "s3cret-value-do-not-leak";
const full = {
  GOOGLE_CLIENT_ID: "cid.apps.example.com",
  GOOGLE_CLIENT_SECRET: SECRET,
  AUTH_ALLOWED_EMAILS: "a@example.com",
  PUBLIC_BASE_URL: "http://localhost:5173",
};

describe("oidc config", () => {
  it("keeps Google off unless id, secret, allowlist and a valid PUBLIC_BASE_URL are all set", () => {
    const { PUBLIC_BASE_URL: _b, ...noBase } = full;
    const { AUTH_ALLOWED_EMAILS: _a, ...noAllow } = full;
    const cases = [
      {},
      { GOOGLE_CLIENT_ID: full.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: SECRET },
      noBase,
      noAllow,
      { ...full, PUBLIC_BASE_URL: "http://my-mac.example.ts.net" },
      { ...full, PUBLIC_BASE_URL: "https://x.example/" },
    ];
    const results = cases.map((env) => loadAuthConfig(env));
    expect(results.map((r) => r.providers)).toEqual([[], [], [], [], [], []]);
    expect(JSON.stringify(results.map((r) => r.warnings))).not.toContain(SECRET);
    // a configured-but-off provider says why
    expect(results[5]?.warnings).toHaveLength(1);
    expect(results[0]?.warnings).toEqual([]);
  });

  it("derives the redirect URI from PUBLIC_BASE_URL and lowercases the allowlist", () => {
    const cfg = loadAuthConfig(full);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]?.redirectUri).toBe(
      "http://localhost:5173/api/auth/oidc/google/callback",
    );
    expect(cfg.providers[0]?.spec.id).toBe("google");
    expect([...cfg.allow.emails]).toEqual(["a@example.com"]);
    expect(cfg.baseUrl).toBe("http://localhost:5173");
    expect(cfg.secureCookie).toBe(false);
  });

  it("parses SA_DEMO_EMAILS into lowercased user-id/email pairs, dropping bad entries", () => {
    expect(parseDemoEmails("ana:Ana@Example.com, bad, vlad:")).toEqual(
      new Map([["ana", "ana@example.com"]]),
    );
  });
});
