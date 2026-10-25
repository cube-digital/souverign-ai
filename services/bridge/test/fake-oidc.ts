import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration";
export const ISS = "https://accounts.google.com";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";

export type FakeUser = {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  hd?: string;
};
type Grant = {
  user: FakeUser;
  nonce: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function fakeOidc(opts: { clientId: string; clientSecret: string }) {
  let pair = await generateKeyPair("RS256", { extractable: true });
  let kid = "k1";
  let n = 1;
  const grants = new Map<string, Grant>();
  /** every URL fetched, without query */
  const calls: string[] = [];
  /** merged into the next ID tokens (e.g. { aud: "other" }) */
  const overrides: Record<string, unknown> = {};

  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid }).sign(pair.privateKey);
  const idClaims = (u: FakeUser, nonce: string, clientId = opts.clientId) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: ISS,
      aud: clientId,
      azp: clientId,
      sub: u.sub,
      email: u.email,
      email_verified: u.email_verified ?? true,
      name: u.name,
      hd: u.hd,
      nonce,
      iat: now,
      exp: now + 3600,
      ...overrides,
    };
  };

  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url.split("?")[0] ?? url);
    if (url === DISCOVERY)
      return json({
        issuer: ISS,
        authorization_endpoint: AUTH,
        token_endpoint: TOKEN,
        jwks_uri: JWKS,
      });
    if (url === JWKS)
      return json({
        keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" }],
      });
    if (url === TOKEN && init?.method === "POST") {
      const f = new URLSearchParams(String(init.body));
      const code = f.get("code") ?? "";
      const g = grants.get(code);
      grants.delete(code);
      const verifierOk =
        createHash("sha256")
          .update(f.get("code_verifier") ?? "")
          .digest("base64url") === g?.challenge;
      if (
        !g ||
        !verifierOk ||
        f.get("grant_type") !== "authorization_code" ||
        f.get("client_id") !== opts.clientId ||
        f.get("client_secret") !== opts.clientSecret ||
        f.get("redirect_uri") !== g.redirectUri
      )
        return json({ error: "invalid_grant" }, 400);
      return json({
        access_token: "unused",
        id_token: await sign(idClaims(g.user, g.nonce, g.clientId)),
      });
    }
    return json({ error: "not_found" }, 404);
  };

  return {
    fetch: fetchFn,
    calls,
    overrides,
    sign,
    idClaims,
    /** what the browser and the consent screen do: returns the callback query values */
    authorize(
      authUrl: string,
      user: FakeUser,
    ): { code: string; state: string; redirectUri: string } {
      const u = new URL(authUrl);
      const q = (k: string) => u.searchParams.get(k) ?? "";
      if (
        u.origin + u.pathname !== AUTH ||
        q("response_type") !== "code" ||
        q("code_challenge_method") !== "S256"
      )
        throw new Error("bad authorize request");
      const code = `code-${grants.size + 1}-${Math.random().toString(36).slice(2)}`;
      grants.set(code, {
        user,
        nonce: q("nonce"),
        challenge: q("code_challenge"),
        redirectUri: q("redirect_uri"),
        clientId: q("client_id"),
      });
      return { code, state: q("state"), redirectUri: q("redirect_uri") };
    },
    async rotateKey() {
      pair = await generateKeyPair("RS256", { extractable: true });
      kid = `k${++n}`;
    },
  };
}
