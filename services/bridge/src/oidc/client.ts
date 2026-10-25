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
const MAX_BODY = 256 * 1024;
const NEGATIVE_MS = 5_000;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

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
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly failed = new Map<string, { at: number; err: unknown }>();

  constructor(
    readonly cfg: OidcProviderConfig,
    private readonly fetchFn: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async getJson(url: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new OidcError("unreachable");
    }
    if (!res.ok) throw new OidcError(`http_${res.status}`);
    try {
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_BODY) throw new OidcError("too_large");
      const text = await readCapped(res);
      return JSON.parse(text);
    } catch (e) {
      if (e instanceof OidcError) throw e;
      throw new OidcError("bad_json");
    }
  }

  /** Single-flight with a short negative cache so a failing provider is not hammered. */
  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const neg = this.failed.get(key);
    if (neg && this.now() - neg.at < NEGATIVE_MS) return Promise.reject(neg.err);
    const cur = this.inflight.get(key) as Promise<T> | undefined;
    if (cur) return cur;
    const p = fn().then(
      (v) => {
        this.inflight.delete(key);
        this.failed.delete(key);
        return v;
      },
      (err: unknown) => {
        this.inflight.delete(key);
        this.failed.set(key, { at: this.now(), err });
        throw err;
      },
    );
    this.inflight.set(key, p);
    return p;
  }

  private endpoint(u: unknown): u is string {
    if (typeof u !== "string") return false;
    try {
      const x = new URL(u);
      return (
        x.protocol === "https:" &&
        (x.port === "" || x.port === "443") &&
        !x.username &&
        !x.password &&
        this.cfg.spec.hosts.includes(x.hostname)
      );
    } catch {
      return false;
    }
  }

  discover(): Promise<Discovery> {
    if (this.discovery) return Promise.resolve(this.discovery);
    return this.once("discovery", () => this.fetchDiscovery());
  }

  private async fetchDiscovery(): Promise<Discovery> {
    const d = (await this.getJson(this.cfg.spec.discoveryUrl)) as Partial<Discovery> | null;
    if (
      !d ||
      typeof d.issuer !== "string" ||
      !this.cfg.spec.issuers.includes(d.issuer) ||
      !this.endpoint(d.authorization_endpoint) ||
      !this.endpoint(d.token_endpoint) ||
      !this.endpoint(d.jwks_uri)
    )
      throw new OidcError("bad_discovery");
    this.discovery = d as Discovery;
    return this.discovery;
  }

  async authorizeUrl(p: { state: string; nonce: string; verifier: string }): Promise<string> {
    const d = await this.discover();
    const u = new URL(d.authorization_endpoint);
    if (!VERIFIER_RE.test(p.verifier)) throw new OidcError("bad_verifier");
    const q: Record<string, string> = {
      ...this.cfg.spec.extraAuthParams,
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.spec.scope,
      state: p.state,
      nonce: p.nonce,
      code_challenge: pkceChallenge(p.verifier),
      code_challenge_method: "S256",
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
    if (Array.isArray(p.aud) && p.aud.length > 1 && p.azp === undefined)
      throw new OidcError("bad_azp");
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
      emailVerified: p.email_verified === true,
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
    try {
      const set = await this.once("jwks", async () => {
        const jwks = (await this.getJson(d.jwks_uri)) as JSONWebKeySet | null;
        if (!jwks || !Array.isArray(jwks.keys)) throw new OidcError("bad_jwks");
        const created = { set: createLocalJWKSet(jwks), at: this.now() };
        this.jwks = created;
        return created.set;
      });
      return set;
    } catch (e) {
      if (this.jwks) return this.jwks.set; // serve stale on refresh failure
      throw e;
    }
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BODY) {
      await reader.cancel();
      throw new OidcError("too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
