import { describe, expect, it } from "vitest";
import { OidcClient, OidcError } from "../src/oidc/client.js";
import { loadAuthConfig } from "../src/oidc/config.js";
import { DISCOVERY, fakeOidc, ISS } from "./fake-oidc.js";

const CID = "cid.apps.example.com";
const env = {
  GOOGLE_CLIENT_ID: CID,
  GOOGLE_CLIENT_SECRET: "s",
  AUTH_ALLOWED_EMAILS: "ana@example.com",
  PUBLIC_BASE_URL: "http://localhost:5173",
};
const provider = () => {
  const p = loadAuthConfig(env).providers[0];
  if (!p) throw new Error("provider expected");
  return p;
};
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe("oidc client hardening", () => {
  it("rejects discovery endpoints outside the provider host allowlist", async () => {
    const f: typeof fetch = async () =>
      json({
        issuer: ISS,
        authorization_endpoint: "https://accounts.google.com/auth",
        token_endpoint: "https://evil.example/token",
        jwks_uri: "https://www.googleapis.com/certs",
      });
    const e = await new OidcClient(provider(), f).discover().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OidcError);
    expect((e as OidcError).reason).toBe("bad_discovery");
  });

  it("refuses redirects, malformed PKCE verifiers and string email_verified", async () => {
    const fake = await fakeOidc({ clientId: CID, clientSecret: "s" });
    let redirect: string | undefined;
    const spy: typeof fetch = (i, init) => {
      redirect = init?.redirect;
      return fake.fetch(i, init);
    };
    const c = new OidcClient(provider(), spy);
    await expect(
      c.authorizeUrl({ state: "s", nonce: "n", verifier: "short" }),
    ).rejects.toBeInstanceOf(OidcError);
    expect(redirect).toBe("error");
    const tok = await fake.sign({
      ...fake.idClaims({ sub: "a", email: "a@example.com" }, "n"),
      email_verified: "true",
    });
    expect((await c.verify(tok, "n")).emailVerified).toBe(false);
  });

  it("serves stale JWKS when a refresh fails and single-flights discovery", async () => {
    const fake = await fakeOidc({ clientId: CID, clientSecret: "s" });
    let t = 1_000_000_000_000;
    let down = false;
    const f: typeof fetch = (i, init) =>
      down && String(i).includes("certs") ? Promise.reject(new Error("down")) : fake.fetch(i, init);
    const c = new OidcClient(provider(), f, () => t);
    await Promise.all([c.discover(), c.discover(), c.discover()]);
    expect(fake.calls.filter((x) => x === DISCOVERY)).toHaveLength(1);
    const claims = fake.idClaims({ sub: "a", email: "a@example.com" }, "n");
    await c.verify(await fake.sign(claims), "n");
    down = true;
    t += 3_700_000;
    expect((await c.verify(await fake.sign(claims), "n")).sub).toBe("a");
  });
});
