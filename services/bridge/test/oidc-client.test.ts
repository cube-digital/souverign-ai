import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { OidcClient, OidcError, pkceChallenge } from "../src/oidc/client.js";
import { loadAuthConfig } from "../src/oidc/config.js";
import { fakeOidc, ISS } from "./fake-oidc.js";

const CID = "cid.apps.example.com";
const SECRET = "client-secret-value";
const VERIFIER = "v".repeat(64);
const NONCE = "nonce-1";
const USER = { sub: "sub-1", email: "Ana@Example.com", name: "Ana", hd: "Example.com" };

async function setup(now?: () => number) {
  const fake = await fakeOidc({ clientId: CID, clientSecret: SECRET });
  const cfg = loadAuthConfig({
    GOOGLE_CLIENT_ID: CID,
    GOOGLE_CLIENT_SECRET: SECRET,
    AUTH_ALLOWED_EMAILS: "ana@example.com",
    PUBLIC_BASE_URL: "http://localhost:5173",
  });
  const provider = cfg.providers[0];
  if (!provider) throw new Error("google provider expected");
  const client = new OidcClient(provider, fake.fetch, now);
  const mint = (over: Record<string, unknown> = {}, user = USER) =>
    fake.sign({ ...fake.idClaims(user, NONCE), ...over });
  return { fake, client, mint };
}

const reason = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(OidcError);
  return (e as OidcError).reason;
};

describe("oidc client", () => {
  it("authorize URL carries state, nonce, S256 challenge and prompt; PKCE matches RFC 7636", async () => {
    const { client } = await setup();
    const u = new URL(
      await client.authorizeUrl({ state: "st-1", nonce: NONCE, verifier: VERIFIER }),
    );
    const q = Object.fromEntries(u.searchParams);
    expect(q.state).toBe("st-1");
    expect(q.nonce).toBe(NONCE);
    expect(q.code_challenge).toBe(pkceChallenge(VERIFIER));
    expect(q.code_challenge_method).toBe("S256");
    expect(q.prompt).toBe("select_account");
    expect(q.client_id).toBe(CID);
    expect(q.redirect_uri).toBe("http://localhost:5173/api/auth/oidc/google/callback");
    // RFC 7636 appendix B test vector
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("fetches nothing at construction and redeems the code with the verifier into lowercased claims", async () => {
    const { fake, client } = await setup();
    expect(fake.calls).toEqual([]);
    const url = await client.authorizeUrl({ state: "s", nonce: NONCE, verifier: VERIFIER });
    const { code } = fake.authorize(url, USER);
    expect(await client.redeem(code, VERIFIER, NONCE)).toEqual({
      sub: "sub-1",
      email: "ana@example.com",
      emailVerified: true,
      name: "Ana",
      domain: "example.com",
    });
  });

  it("rejects redeem with the wrong PKCE verifier", async () => {
    const { fake, client } = await setup();
    const url = await client.authorizeUrl({ state: "s", nonce: NONCE, verifier: VERIFIER });
    const { code } = fake.authorize(url, USER);
    expect(await reason(client.redeem(code, "w".repeat(64), NONCE))).toBe("http_400");
  });

  it("rejects ID tokens with wrong aud, iss, azp or an expired exp", async () => {
    const { client, mint } = await setup();
    const past = Math.floor(Date.now() / 1000) - 7200;
    expect(await reason(client.verify(await mint({ aud: "other" }), NONCE))).toBe("bad_token");
    expect(await reason(client.verify(await mint({ iss: "https://evil.example" }), NONCE))).toBe(
      "bad_token",
    );
    expect(await reason(client.verify(await mint({ azp: "other" }), NONCE))).toBe("bad_azp");
    expect(await reason(client.verify(await mint({ iat: past - 60, exp: past }), NONCE))).toBe(
      "bad_token",
    );
    // control: the same helper without overrides is accepted
    expect((await client.verify(await mint(), NONCE)).sub).toBe("sub-1");
  });

  it("rejects a nonce mismatch and a missing nonce", async () => {
    const { client, mint } = await setup();
    expect(await reason(client.verify(await mint(), "other-nonce"))).toBe("bad_nonce");
    expect(await reason(client.verify(await mint({ nonce: undefined }), NONCE))).toBe("bad_nonce");
  });

  it("rejects non-RS256 algorithms: HS256 and none", async () => {
    const { client, mint } = await setup();
    const claims = {
      iss: ISS,
      aud: CID,
      azp: CID,
      sub: "sub-1",
      email: "a@example.com",
      nonce: NONCE,
    };
    const hs = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const none = `${b64({ alg: "none" })}.${b64({ ...claims, iat: now, exp: now + 3600 })}.`;
    expect(await reason(client.verify(hs, NONCE))).toBe("bad_token");
    expect(await reason(client.verify(none, NONCE))).toBe("bad_token");
    expect((await client.verify(await mint(), NONCE)).sub).toBe("sub-1");
  });

  it("reports email_verified false so callers can refuse the login", async () => {
    const { client, mint } = await setup();
    const claims = await client.verify(await mint({ email_verified: false }), NONCE);
    expect(claims.emailVerified).toBe(false);
  });

  it("refetches the JWKS exactly once when the signing key rotates", async () => {
    let t = 1_000_000_000_000;
    const { fake, client, mint } = await setup(() => t);
    const jwksCount = () => fake.calls.filter((c: string) => c.endsWith("/oauth2/v3/certs")).length;
    await client.verify(await mint(), NONCE);
    expect(jwksCount()).toBe(1);
    await fake.rotateKey();
    t += 61_000;
    expect((await client.verify(await mint(), NONCE)).sub).toBe("sub-1");
    expect(jwksCount()).toBe(2);
  });
});
