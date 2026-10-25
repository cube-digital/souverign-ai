import { createHash, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTPayload, jwtVerify } from "jose";
import type { OidcProviderConfig } from "./config.js";

export type Fetch = typeof fetch;
export type IdClaims = {
  sub: string;
  /** lowercased */
  email: string;
  emailVerified: boolean;
  name?: string;
  /** value of spec.domainClaim, lowercased */
  domain?: string;
};
export class OidcError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};
type KeySet = ReturnType<typeof createLocalJWKSet>;

const TIMEOUT_MS = 10_000;
const JWKS_TTL_MS = 3_600_000;
const JWKS_MIN_REFETCH_MS = 60_000;

const same = (a: string, b: string): boolean => {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

export const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

export class OidcClient {
  private discovery?: Discovery;
  private jwks?: { set: KeySet; at: number };

  constructor(
    readonly cfg: OidcProviderConfig,
    private readonly fetchFn: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async getJson(url: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new OidcError("unreachable");
    }
    if (!res.ok) throw new OidcError(`http_${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new OidcError("bad_json");
    }
  }

  async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const d = (await this.getJson(this.cfg.spec.discoveryUrl)) as Partial<Discovery> | null;
    const https = (u: unknown): u is string => typeof u === "string" && u.startsWith("https://");
    if (
      !d ||
      typeof d.issuer !== "string" ||
      !this.cfg.spec.issuers.includes(d.issuer) ||
      !https(d.authorization_endpoint) ||
      !https(d.token_endpoint) ||
      !https(d.jwks_uri)
    )
      throw new OidcError("bad_discovery");
    this.discovery = d as Discovery;
    return this.discovery;
  }

  async authorizeUrl(p: { state: string; nonce: string; verifier: string }): Promise<string> {
    const d = await this.discover();
    const u = new URL(d.authorization_endpoint);
    const q: Record<string, string> = {
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.spec.scope,
      state: p.state,
      nonce: p.nonce,
      code_challenge: pkceChallenge(p.verifier),
      code_challenge_method: "S256",
      ...this.cfg.spec.extraAuthParams,
    };
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.toString();
  }

  /** Redeems the authorization code and returns the verified ID token claims. Throws OidcError. */
  async redeem(code: string, verifier: string, nonce: string): Promise<IdClaims> {
    const d = await this.discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.cfg.redirectUri,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code_verifier: verifier,
    });
    const tok = (await this.getJson(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    })) as { id_token?: unknown } | null;
    if (typeof tok?.id_token !== "string") throw new OidcError("no_id_token");
    return this.verify(tok.id_token, nonce);
  }

  async verify(idToken: string, nonce: string): Promise<IdClaims> {
    const p = await this.verifySignature(idToken);
    if (typeof p.nonce !== "string" || !same(p.nonce, nonce)) throw new OidcError("bad_nonce");
    if (p.azp !== undefined && p.azp !== this.cfg.clientId) throw new OidcError("bad_azp");
    if (typeof p.sub !== "string" || p.sub.length === 0 || p.sub.length > 255)
      throw new OidcError("bad_sub");
    if (typeof p.email !== "string" || !p.email.includes("@")) throw new OidcError("no_email");
    const claim = this.cfg.spec.domainClaim;
    const domain =
      claim && typeof p[claim] === "string" ? (p[claim] as string).toLowerCase() : undefined;
    return {
      sub: p.sub,
      email: p.email.toLowerCase(),
      emailVerified: p.email_verified === true || p.email_verified === "true",
      ...(typeof p.name === "string" ? { name: p.name } : {}),
      ...(domain ? { domain } : {}),
    };
  }

  private async verifySignature(idToken: string): Promise<JWTPayload> {
    const d = await this.discover();
    const opts = {
      issuer: this.cfg.spec.issuers,
      audience: this.cfg.clientId,
      algorithms: ["RS256"],
      clockTolerance: 60,
      maxTokenAge: "10m",
      requiredClaims: ["iat", "exp", "sub"],
    };
    const first = await this.keys(d, false);
    try {
      return (await jwtVerify(idToken, first, opts)).payload;
    } catch (e) {
      if (!(e instanceof errors.JWKSNoMatchingKey)) throw new OidcError("bad_token");
    }
    const again = await this.keys(d, true);
    try {
      return (await jwtVerify(idToken, again, opts)).payload;
    } catch {
      throw new OidcError("bad_token");
    }
  }

  private async keys(d: Discovery, refresh: boolean): Promise<KeySet> {
    const age = this.jwks ? this.now() - this.jwks.at : Number.POSITIVE_INFINITY;
    if (this.jwks && (refresh ? age < JWKS_MIN_REFETCH_MS : age < JWKS_TTL_MS))
      return this.jwks.set;
    const jwks = (await this.getJson(d.jwks_uri)) as JSONWebKeySet | null;
    if (!jwks || !Array.isArray(jwks.keys)) throw new OidcError("bad_jwks");
    this.jwks = { set: createLocalJWKSet(jwks), at: this.now() };
    return this.jwks.set;
  }
}
