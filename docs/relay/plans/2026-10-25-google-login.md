# Sign in with Google Plan

**Goal:** people can sign in with a Google account that is on an allowlist. The bridge runs a provider-agnostic OIDC client with Google as the first provider. The demo PIN login keeps working, and Google sign-in stays off (no route, no egress) until `.env` enables it.
**Spec:** owner request of 2026-10-25 (this plan's Decisions are the spec). Code map: `relay/sa-agent-teammates/integration` after the T1 plan (`2026-10-24-agent-teammates.md`) merges; this run starts from main once that has landed.
**Architecture:** a bridge plugin `src/plugins/oidc.ts` (the T4 plugin loader discovers it) runs the authorization code flow with PKCE, state and nonce. It verifies the ID token against the provider's JWKS with `jose` and maps (`provider`, `sub`) to an `sa.users` row through a new `sa.identities` table. The plugin then hands the browser a 60-second one-time code in the URL fragment, and the SPA exchanges it for the ordinary bearer session (`sa.sessions`), the same one the PIN login issues. Device keys, registration and the relay are unchanged: the browser still generates and keeps its keys, and the bridge never sees them.

## Decisions

- **Off by default.** `loadAuthConfig(env)` enables Google only when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and a valid `PUBLIC_BASE_URL` are set, plus at least one entry in `AUTH_ALLOWED_EMAILS` or `AUTH_ALLOWED_DOMAINS`. When any of these is missing, the bridge logs `oidc disabled` with the missing env names (never their values). It registers only `GET /api/auth/providers` → `{pin:true, oidc:[]}`, makes no outbound request, and `/api/auth/oidc/*` returns 404.
- **D-14: Google sign-in is the only deliberate egress.** The bridge contacts only Google's OAuth hosts (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`), and only while Google sign-in is enabled. When it is enabled, the web says so wherever trust is claimed. The login page and the TopBar trust strip show "Sign-in uses Google · chats and AI stay on this Mac" instead of the usual trust line, and the Presenter page shows a warning badge "Google sign-in on". The `make smoke` egress guard allowlists exactly those three hosts on port 443, and only when the same env that enables Google is set. Otherwise the guard stays at 0 bytes allowed, exactly as today. Chats, files, device keys and every model stay local in both modes.
- **No egress at startup.** Even when Google is enabled, the discovery document and the JWKS are fetched lazily, on the first `start`/`callback`. They are never fetched at boot. This keeps the `make smoke` egress guard at 0 bytes whether or not `.env` enables Google, as long as nobody signs in during the smoke run.
- **`PUBLIC_BASE_URL`** must be `https://<host>[:port]`, or `http://localhost:<port>` / `http://127.0.0.1:<port>`, with no path, query or trailing slash. The redirect URI is always `${PUBLIC_BASE_URL}/api/auth/oidc/<provider>/callback`, and the `Host` header is never used. The Vite dev server (and `make share` in front of it) already proxies `/api` to the bridge.
- **Provider spec** (`oidc/providers.ts`): `{id, label, discoveryUrl, issuers[], scope, domainClaim?, extraAuthParams?}`. Google is `id "google"`, with issuers `https://accounts.google.com` and `accounts.google.com` (Google issues both), scope `openid email profile`, `domainClaim "hd"` and `prompt=select_account`. A later provider (for example a cloud IdP when the app moves to AWS) is one more spec plus env names in `config.ts`.
- **Flow.**
  - `start` creates `state`, `nonce` and a PKCE `verifier` (each `newToken()`, 43 base64url chars), with challenge S256. It stores them in memory (TTL 10 min, at most 1000 pending) and sets the cookie `sa_oidc=<state>; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=600` (plus `Secure` when the base URL is https). Then it redirects (302) to the authorization endpoint.
  - `callback` always clears the cookie, then checks: query `state` equals the cookie (constant-time), the entry exists for this provider and has not expired, and the entry is deleted before use (single use). It then redeems the code (client_secret_post + `code_verifier`), verifies the ID token, resolves the user, and redirects to `${PUBLIC_BASE_URL}/#sa_login=<one-time code>`. On failure it redirects to `/#sa_login_error=<expired|cancelled|failed|unavailable|busy|not_allowed|conflict>`.
  - `POST /api/auth/oidc/exchange {code}` redeems the one-time code (stored only as a sha256 hash, TTL 60 s, deleted on first use) and returns a `LoginResponse`. The bearer token never appears in a URL.
- **ID token checks:** RS256 only. `iss` must be in `issuers` (and the discovery issuer must be too). `aud` must equal the client id. `azp`, when present, must equal the client id. `exp`/`iat` are checked with 60 s clock tolerance, and the token may be at most 10 minutes old. `nonce` must match, `sub` must be non-empty, and `email_verified` must be true. On an unknown `kid` the client fetches the JWKS once more (at most once per 60 s). Discovery is cached for the life of the process and the JWKS for 1 h. Every outbound call has a 10 s timeout.
- **Allowlist:** it is checked on every login, including for users who are already linked, so removing an email from `.env` locks that account out at the next sign-in. Rules:
  - The address is in `AUTH_ALLOWED_EMAILS` (case-insensitive exact match).
  - Or its domain is in `AUTH_ALLOWED_DOMAINS` **and** the token's `hd` claim equals that domain. A plain Google account that merely uses a company address does not pass; only accounts managed by that Workspace domain do.
  - A provider without `domainClaim` matches domains on the email suffix alone.
- **User mapping** (`oidc/users.ts`), in this order:
  1. A known (`provider`, `sub`) signs in as its user.
  2. An existing user with `kind = 'person'` and the same `email` is linked. This is how a seeded demo user such as `ana` gets Google sign-in: `SA_DEMO_EMAILS=ana:ana@example.com` + `make seed`.
  3. Otherwise a new user is created with id `u_<16 hex>`, display name from the `name` claim (control characters stripped, at most 80 chars, else the email local part), `pin_hash = 'disabled'` and `kind = 'person'`.
  - Seed colleagues (`kind = 'seed'`) are never linked or signed in.
  - Each user has at most one identity per provider. When a different `sub` arrives for an already linked email, the result is `conflict`; the admin fixes it by deleting the old `sa.identities` row.
- **Picker:** `GET /api/users`, the PIN picker, hides users with `pin_hash = 'disabled'`. The plugin does this through a Fastify `preSerialization` hook on that route; Fastify applies root hooks to all routes at `preReady`, so the hook covers routes registered earlier. Google-created users still appear in the directory, so others can add them to chats.
- **Everything through the plugin.** No task edits `services/bridge/src/app.ts` or `main.ts`. Routes, the picker hook and first-run wiring all live in `src/plugins/oidc.ts`, which the T1-plan plugin loader (T4) discovers.
- **First run for a Google-created user** matches the demo users, so nobody lands in an empty workspace:
  - Right after `resolveUser` returns `created: true`, the plugin adds the user as `member` to every seeded room (`kind = 'room'`, `seed_key` and `history_until_seq` not null). It then calls `hooks.onMemberAdded(chatId, userId)` per room, which is the workspace plugin's custodian `grant` path (T1-plan T10).
  - The user has no device yet. When the browser registers one, `hooks.onDeviceRegistered` grants that device the history window and the room keys, exactly as for a demo user who signs in the first time.
  - The bridge redirects to `/`. The T20 router sends a never-welcomed user to `/welcome`, where "Get started" opens the Scribe DM (T19). The bridge creates no extra Scribe DM.
- **PIN login is unchanged** and stays on even when Google is enabled. Turning PIN login off for a hosted deployment is a later decision (see the report).
- **Defaults agreed with the owner (2026-10-25).** PIN login stays on, also when Google is enabled; switching it off for a hosted deployment is a later decision. A different Google `sub` for an already linked email is refused as `conflict`, and is never auto-relinked. If Google Console rejects the `*.ts.net` redirect URI, use `PUBLIC_BASE_URL=http://localhost:5173` and register the localhost callback instead.
- **Migration order.** This plan runs after T1 and the memory+approvals plan (which owns `004`), so its migration is `005_identity.sql`; voice+meetings follows with `006`.
- **Logs:** they record provider, reason code and user id only. Emails, names, codes, tokens, `state` and `nonce` are never logged.

## Global Constraints

- SP2 conventions: TS `@sa/*`, NodeNext `.js` imports (web: Bundler), Biome, vitest. Commits are `feat(auth): …` / `test(auth): …`, one per task.
- Only G1 changes `package.json` files or `pnpm-lock.yaml`. A missing dependency means NEEDS_CONTEXT.
- The repo is public: no client company or product names, no absolute paths of this machine, and no real email addresses (use `example.com`/`example.org`). `git grep -inE "real[t]yme|gate[x]"` must print nothing before every commit, commit messages included.
- Tests never touch the network. OIDC tests inject `fetch` from `services/bridge/test/fake-oidc.ts`. Bridge tests use `pglite://memory` like `bridge.test.ts`.
- Never write `GOOGLE_CLIENT_SECRET` to `.run/`, logs or the repo. `.env` stays gitignored.
- `make check` must pass with no Google env set.
- No task edits `services/bridge/src/app.ts` or `services/bridge/src/main.ts` (see Decisions, "Everything through the plugin").

## Review Focus

- With no Google env set: zero `fetch` calls, `/api/auth/oidc/*` → 404, and the Login screen shows no Google button.
- A callback without the matching `sa_oidc` cookie, with a replayed `state`, or with an expired `state` never reaches the token endpoint.
- The one-time login code works once and only within 60 s. Neither it nor the bearer token appears in a query string or a log.
- An ID token with the wrong `aud`/`iss`/`nonce`, `alg` other than RS256, `email_verified: false` or an expired `exp` never creates a session.
- `hd` is required for domain allowlisting. Removing an email from the allowlist blocks an already linked user. Seed colleagues can never be reached through OIDC.
- Two concurrent first logins for one email produce one user and one identity (`on conflict` paths).
- The PIN login, PIN rate limit and `/presenter` slots behave exactly as before.
- D-14: with Google off, the egress guard allowlist is empty and no Google copy or badge appears. With it on, the allowlist holds only the three OAuth hosts on 443.
- A Google-created user who registers a device decrypts the seeded history in all four rooms, like a demo user. Non-seed rooms are never auto-joined.

## Before the run (human)

Nothing blocks the run itself, because all tests use the fake provider. To try it for real afterwards:

1. Open https://console.cloud.google.com and create (or pick) a project with a neutral name, for example `sovereign-agents-demo`.
2. **Google Auth Platform → Branding:** set the app name ("Sovereign Agents") and the support email. **Audience:** choose *Internal* if every user is in your Google Workspace domain. Otherwise choose *External* and leave it in **Testing**, then add each person under *Test users*. In Testing mode Google itself refuses anyone not listed, which acts as a second allowlist. **Data access:** add only `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. These are non-sensitive scopes, so no verification is needed.
3. **Clients → Create client → Web application.** Leave *Authorized JavaScript origins* empty, because the flow is server-side. Under *Authorized redirect URIs*, add each base URL you will use, exactly (scheme, host, port, no trailing slash):
   - `http://localhost:5173/api/auth/oidc/google/callback` (local `make dev`)
   - `https://<mac-name>.<tailnet>.ts.net/api/auth/oidc/google/callback` (after `make share`; `tailscale serve status` prints the name)
   - later, `https://<aws-host>/api/auth/oidc/google/callback`
4. Copy the client ID and secret into `.env`:
   ```
   PUBLIC_BASE_URL=https://<mac-name>.<tailnet>.ts.net   # or http://localhost:5173
   GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=<secret>
   AUTH_ALLOWED_EMAILS=you@example.com,colleague@example.com
   AUTH_ALLOWED_DOMAINS=                                   # optional, Workspace domains only
   SA_DEMO_EMAILS=ana:you@example.com                      # optional: link a demo user, then `make seed`
   ```
5. Restart `make dev`, open `PUBLIC_BASE_URL` (the same origin you registered) and click **Sign in with Google**. Google never needs to reach the Mac: the browser carries the redirect, and the bridge calls `accounts.google.com`, `oauth2.googleapis.com` and `www.googleapis.com` outbound only during a sign-in. With these values in `.env`, `make smoke` allowlists those three hosts (D-14); remove them to return to strict 0-egress.

## Tasks

### G1: Shapes, migration, config, provider spec, dependency

```bash
pnpm --filter @sa/bridge add jose@^6
```

`packages/protocol/src/index.ts` (append):

```ts
export const AuthProviders = z.object({
  pin: z.boolean(),
  oidc: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,32}$/), label: z.string().max(40) })),
});
export type AuthProviders = z.infer<typeof AuthProviders>;
export const OidcExchangeRequest = z.object({ code: z.string().min(20).max(128) });
export type OidcExchangeRequest = z.infer<typeof OidcExchangeRequest>;
```

`services/bridge/src/migrations/005_identity.sql`:

```sql
alter table sa.users add column if not exists email text unique check (email = lower(email));
create table if not exists sa.identities (
  provider text not null,
  subject text not null,
  user_id text not null references sa.users,
  email text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  primary key (provider, subject),
  unique (provider, user_id)
);
```

`services/bridge/src/oidc/providers.ts`:

```ts
export type OidcProviderSpec = {
  id: string;
  label: string;
  discoveryUrl: string;
  /** accepted `iss` values; the discovery document's issuer must be one of them */
  issuers: string[];
  scope: string;
  /** claim naming the account's managed domain; domain allowlist entries must equal it */
  domainClaim?: string;
  extraAuthParams?: Record<string, string>;
};

export const GOOGLE: OidcProviderSpec = {
  id: "google",
  label: "Google",
  discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
  scope: "openid email profile",
  domainClaim: "hd",
  extraAuthParams: { prompt: "select_account" },
};
```

`services/bridge/src/oidc/config.ts`:

```ts
import { GOOGLE, type OidcProviderSpec } from "./providers.js";

export type OidcProviderConfig = {
  spec: OidcProviderSpec;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};
export type AllowList = { emails: Set<string>; domains: Set<string> };
export type AuthConfig = {
  /** PUBLIC_BASE_URL origin, no trailing slash; "" when unset or invalid */
  baseUrl: string;
  secureCookie: boolean;
  allow: AllowList;
  /** enabled providers; empty = OIDC off */
  providers: OidcProviderConfig[];
  /** why a configured provider is off; env names only, never values */
  warnings: string[];
};

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function parseBaseUrl(v: string | undefined): string | null {
  if (!v?.trim()) return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return null;
  if (v.trim().endsWith("/")) return null;
  return u.origin;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const allow: AllowList = {
    emails: new Set(list(env.AUTH_ALLOWED_EMAILS).filter((e) => e.includes("@"))),
    domains: new Set(list(env.AUTH_ALLOWED_DOMAINS).map((d) => d.replace(/^@/, ""))),
  };
  const baseUrl = parseBaseUrl(env.PUBLIC_BASE_URL);
  const warnings: string[] = [];
  const providers: OidcProviderConfig[] = [];
  const id = env.GOOGLE_CLIENT_ID?.trim();
  const secret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (id || secret) {
    if (!id || !secret) warnings.push("google: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both required");
    else if (allow.emails.size + allow.domains.size === 0)
      warnings.push("google: set AUTH_ALLOWED_EMAILS or AUTH_ALLOWED_DOMAINS");
    else if (!baseUrl)
      warnings.push("google: PUBLIC_BASE_URL must be https://<host> or http://localhost:<port>");
    else
      providers.push({
        spec: GOOGLE,
        clientId: id,
        clientSecret: secret,
        redirectUri: `${baseUrl}/api/auth/oidc/${GOOGLE.id}/callback`,
      });
  }
  return {
    baseUrl: baseUrl ?? "",
    secureCookie: baseUrl?.startsWith("https:") ?? false,
    allow,
    providers,
    warnings,
  };
}

/** `ana:ana@example.com,vlad:...` → Map(user id → lowercased email); entries without "@" are dropped. */
export function parseDemoEmails(v: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (v ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const id = part.slice(0, i).trim();
    const email = part.slice(i + 1).trim().toLowerCase();
    if (id && email.includes("@")) out.set(id, email);
  }
  return out;
}
```

`.env.example` (append after `HERMES_BIN=`):

```
PUBLIC_BASE_URL=        # e.g. https://<mac>.<tailnet>.ts.net or http://localhost:5173 ; sign-in redirects return here
GOOGLE_CLIENT_ID=       # empty = Google sign-in off (docs/auth.md)
GOOGLE_CLIENT_SECRET=
AUTH_ALLOWED_EMAILS=    # comma list; Google sign-in stays off unless this or AUTH_ALLOWED_DOMAINS is set
AUTH_ALLOWED_DOMAINS=   # comma list of Google Workspace domains (must match the account's hd claim)
SA_DEMO_EMAILS=         # e.g. ana:you@example.com ; make seed links that demo user to this sign-in email
```

Tests (`services/bridge/test/oidc-config.test.ts`):
- Off by default. Each of the following yields `providers: []`: empty env; only the id and secret; the id, secret and allowlist but no `PUBLIC_BASE_URL`; `PUBLIC_BASE_URL=http://my-mac.example.ts.net`; and `PUBLIC_BASE_URL=https://x.example/`. The warnings never contain the secret value.
- On: the id, secret, `AUTH_ALLOWED_EMAILS=A@Example.com` and `PUBLIC_BASE_URL=http://localhost:5173` give one provider. It has redirect `http://localhost:5173/api/auth/oidc/google/callback`, the email set holds `a@example.com`, and `secureCookie` is false.
- `parseDemoEmails("ana:Ana@Example.com, bad, vlad:")` → `{ana → ana@example.com}`.

### G2: OIDC client and fake provider

`services/bridge/src/oidc/client.ts`:

```ts
import { createHash } from "node:crypto";
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
    if (typeof p.nonce !== "string" || p.nonce !== nonce) throw new OidcError("bad_nonce");
    if (p.azp !== undefined && p.azp !== this.cfg.clientId) throw new OidcError("bad_azp");
    if (typeof p.sub !== "string" || p.sub.length === 0 || p.sub.length > 255)
      throw new OidcError("bad_sub");
    if (typeof p.email !== "string" || !p.email.includes("@")) throw new OidcError("no_email");
    const claim = this.cfg.spec.domainClaim;
    const domain = claim && typeof p[claim] === "string" ? (p[claim] as string).toLowerCase() : undefined;
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
    if (this.jwks && (refresh ? age < JWKS_MIN_REFETCH_MS : age < JWKS_TTL_MS)) return this.jwks.set;
    const jwks = (await this.getJson(d.jwks_uri)) as JSONWebKeySet | null;
    if (!jwks || !Array.isArray(jwks.keys)) throw new OidcError("bad_jwks");
    this.jwks = { set: createLocalJWKSet(jwks), at: this.now() };
    return this.jwks.set;
  }
}
```

`services/bridge/test/fake-oidc.ts` (a test helper; it acts as Google behind an injected `fetch`, with no sockets):

```ts
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration";
export const ISS = "https://accounts.google.com";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";

export type FakeUser = { sub: string; email: string; email_verified?: boolean; name?: string; hd?: string };
type Grant = { user: FakeUser; nonce: string; challenge: string; redirectUri: string; clientId: string };

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
      iss: ISS, aud: clientId, azp: clientId, sub: u.sub, email: u.email,
      email_verified: u.email_verified ?? true, name: u.name, hd: u.hd, nonce,
      iat: now, exp: now + 3600, ...overrides,
    };
  };

  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url.split("?")[0] ?? url);
    if (url === DISCOVERY)
      return json({ issuer: ISS, authorization_endpoint: AUTH, token_endpoint: TOKEN, jwks_uri: JWKS });
    if (url === JWKS)
      return json({ keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" }] });
    if (url === TOKEN && init?.method === "POST") {
      const f = new URLSearchParams(String(init.body));
      const code = f.get("code") ?? "";
      const g = grants.get(code);
      grants.delete(code);
      const verifierOk =
        createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === g?.challenge;
      if (
        !g || !verifierOk || f.get("grant_type") !== "authorization_code" ||
        f.get("client_id") !== opts.clientId || f.get("client_secret") !== opts.clientSecret ||
        f.get("redirect_uri") !== g.redirectUri
      )
        return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "unused", id_token: await sign(idClaims(g.user, g.nonce, g.clientId)) });
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
    authorize(authUrl: string, user: FakeUser): { code: string; state: string; redirectUri: string } {
      const u = new URL(authUrl);
      const q = (k: string) => u.searchParams.get(k) ?? "";
      if (u.origin + u.pathname !== AUTH || q("response_type") !== "code" || q("code_challenge_method") !== "S256")
        throw new Error("bad authorize request");
      const code = `code-${grants.size + 1}-${Math.random().toString(36).slice(2)}`;
      grants.set(code, {
        user, nonce: q("nonce"), challenge: q("code_challenge"),
        redirectUri: q("redirect_uri"), clientId: q("client_id"),
      });
      return { code, state: q("state"), redirectUri: q("redirect_uri") };
    },
    async rotateKey() {
      pair = await generateKeyPair("RS256", { extractable: true });
      kid = `k${++n}`;
    },
  };
}
```

Tests (`services/bridge/test/oidc-client.test.ts`). Build the config with `loadAuthConfig` (localhost base URL, `AUTH_ALLOWED_EMAILS`), then `new OidcClient(cfg.providers[0], fake.fetch)`.
- Round trip: `authorizeUrl` carries `code_challenge = pkceChallenge(verifier)`, `state`, `nonce` and `prompt=select_account`. `fake.authorize` + `redeem(code, verifier, nonce)` returns the lowercased email and `emailVerified: true`.
- `redeem` with the wrong verifier → `OidcError` (`http_400`).
- Each of these is rejected by `verify`: `overrides.aud = "other"`, `overrides.iss = "https://evil.example"`, wrong nonce, `overrides.exp` in the past, `overrides.azp = "other"`, and an HS256 token signed with a shared secret (via `new SignJWT(...).setProtectedHeader({alg:"HS256"})`).
- After `fake.rotateKey()`, a fresh token verifies through a single extra JWKS fetch (count `calls`).

### G3: User mapping and demo email linking

`services/bridge/src/oidc/users.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import type { IdClaims } from "./client.js";
import type { AllowList } from "./config.js";

export type Resolved =
  | { ok: true; userId: string; displayName: string; created: boolean }
  | { ok: false; reason: "not_allowed" | "conflict" };
type UserRow = { id: string; display_name: string; kind: string };

export function isAllowed(c: IdClaims, allow: AllowList, domainClaim?: string): boolean {
  if (!c.emailVerified) return false;
  if (allow.emails.has(c.email)) return true;
  const domain = c.email.slice(c.email.lastIndexOf("@") + 1);
  if (!domain || !allow.domains.has(domain)) return false;
  return domainClaim ? c.domain === domain : true;
}

export function displayName(c: IdClaims): string {
  const clean = (c.name ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 80);
  return clean || (c.email.split("@")[0] ?? "user").slice(0, 80);
}

export async function resolveUser(
  db: Db,
  provider: string,
  c: IdClaims,
  allow: AllowList,
  domainClaim?: string,
): Promise<Resolved> {
  if (!isAllowed(c, allow, domainClaim)) return { ok: false, reason: "not_allowed" };
  const [known] = await db.query<UserRow>(
    `select u.id, u.display_name, u.kind from sa.identities i join sa.users u on u.id = i.user_id
     where i.provider = $1 and i.subject = $2`,
    [provider, c.sub],
  );
  if (known) {
    if (known.kind !== "person") return { ok: false, reason: "not_allowed" };
    await db.query(
      "update sa.identities set email = $3, last_login_at = now() where provider = $1 and subject = $2",
      [provider, c.sub, c.email],
    );
    return { ok: true, userId: known.id, displayName: known.display_name, created: false };
  }
  const byEmail = () =>
    db.query<UserRow>("select id, display_name, kind from sa.users where email = $1", [c.email]);
  let created = false;
  let [u] = await byEmail();
  if (!u) {
    const rows = await db.query<UserRow>(
      `insert into sa.users (id, display_name, pin_hash, email) values ($1, $2, 'disabled', $3)
       on conflict do nothing returning id, display_name, kind`,
      [`u_${randomBytes(8).toString("hex")}`, displayName(c), c.email],
    );
    created = rows.length > 0;
    [u] = created ? rows : await byEmail();
  }
  if (!u || u.kind !== "person") return { ok: false, reason: "not_allowed" };
  const linked = await db.query(
    `insert into sa.identities (provider, subject, user_id, email) values ($1, $2, $3, $4)
     on conflict do nothing returning user_id`,
    [provider, c.sub, u.id, c.email],
  );
  if (linked.length === 0) {
    const [again] = await db.query<{ user_id: string }>(
      "select user_id from sa.identities where provider = $1 and subject = $2",
      [provider, c.sub],
    );
    if (again?.user_id !== u.id) return { ok: false, reason: "conflict" };
  }
  return { ok: true, userId: u.id, displayName: u.display_name, created };
}
```

`services/bridge/src/seed.ts`: after the user loop and before `db.close()`, read `parseDemoEmails(process.env.SA_DEMO_EMAILS)` (import from `./oidc/config.js`). For each entry run `update sa.users set email = $2 where id = $1 and kind = 'person'`, then log `demo email linked` with the id only. Unknown ids are skipped silently.

Tests (`services/bridge/test/oidc-users.test.ts`, pglite, `migrate`, users `ana` (person, PIN, email `ana@example.com`) and `mira` (`kind = 'seed'`, `pin_hash 'disabled'`, email `mira@example.com`)). Allowlist: emails `{ana@example.com, new@example.com, mira@example.com}`, domains `{corp.example}`.
- `new@example.com` creates `u_…` with `created: true`. A second call with the same sub returns the same id with `created: false`.
- `ana@example.com` with a new sub links to `ana` (same id, no new user). A different sub for the same email then returns `conflict`.
- Each of these is refused with `not_allowed`: `email_verified: false`; `x@corp.example` without `hd`; `out@example.org`; and `mira@example.com`. `x@corp.example` with `hd: "corp.example"` is allowed.
- A linked user whose email has been removed from the allowlist is refused.

### G4: OIDC plugin — start, callback, exchange

`services/bridge/src/plugins/oidc.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import { type AuthProviders, type LoginResponse, OidcExchangeRequest } from "@sa/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hashToken, newToken, SESSION_HOURS } from "../auth.js";
import { type Fetch, OidcClient, OidcError } from "../oidc/client.js";
import { type AuthConfig, loadAuthConfig } from "../oidc/config.js";
import { resolveUser } from "../oidc/users.js";
import type { BridgeHooks } from "../agents/api.js";
import type { Db } from "../db.js";
import type { BridgePlugin, Log } from "../plugin-api.js";

const STATE_TTL_MS = 600_000;
const CODE_TTL_MS = 60_000;
const MAX_PENDING = 1000;
const COOKIE = "sa_oidc";
const COOKIE_PATH = "/api/auth/oidc";

type Pending = { provider: string; nonce: string; verifier: string; expires: number };
type LoginCode = { userId: string; displayName: string; provider: string; expires: number };

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const reasonOf = (e: unknown) => (e instanceof OidcError ? e.reason : "error");

function readCookie(req: FastifyRequest): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}

/** First run (Decisions): a new user joins every seeded room through the workspace grant path. */
async function joinSeedRooms(db: Db, hooks: BridgeHooks, log: Log, userId: string): Promise<void> {
  const rooms = await db.query<{ id: string }>(
    "select id from sa.chats where kind = 'room' and seed_key is not null and history_until_seq is not null order by id",
  );
  for (const r of rooms) {
    await db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'user', $2, 'member') on conflict do nothing",
      [r.id, userId],
    );
    try {
      await hooks.onMemberAdded?.(r.id, userId);
    } catch {
      log("oidc seed room grant failed", { chat: r.id, user: userId });
    }
  }
}

export function createOidcPlugin(
  opts: { env?: NodeJS.ProcessEnv; fetch?: Fetch; now?: () => number } = {},
): BridgePlugin {
  const now = opts.now ?? Date.now;
  return {
    name: "oidc",
    routes(app, { db, log, hooks }) {
      const c: AuthConfig = loadAuthConfig(opts.env ?? process.env);
      for (const w of c.warnings) log("oidc disabled", { reason: w });
      const clients = new Map(
        c.providers.map((p) => [p.spec.id, new OidcClient(p, opts.fetch ?? fetch, now)]),
      );
      app.get(
        "/api/auth/providers",
        async (): Promise<AuthProviders> => ({
          pin: true,
          oidc: c.providers.map((p) => ({ id: p.spec.id, label: p.spec.label })),
        }),
      );
      // PIN picker: hide users who have no PIN (Google-created). Always on, also when OIDC is off.
      app.addHook("preSerialization", async (req, _reply, payload: unknown) => {
        if (req.method !== "GET" || req.routeOptions.url !== "/api/users" || !Array.isArray(payload))
          return payload;
        const rows = await db.query<{ id: string }>("select id from sa.users where pin_hash = 'disabled'");
        const hidden = new Set(rows.map((r) => r.id));
        return payload.filter((u: { id?: unknown }) => !(typeof u?.id === "string" && hidden.has(u.id)));
      });
      if (clients.size === 0) return;

      const pending = new Map<string, Pending>();
      const codes = new Map<string, LoginCode>();
      const sweep = () => {
        const t = now();
        for (const [k, v] of pending) if (v.expires <= t) pending.delete(k);
        for (const [k, v] of codes) if (v.expires <= t) codes.delete(k);
      };
      const cookie = (value: string, maxAgeS: number) =>
        `${COOKIE}=${value}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${c.secureCookie ? "; Secure" : ""}`;
      const back = (reply: FastifyReply, fragment: string) =>
        reply
          .header("cache-control", "no-store")
          .header("referrer-policy", "no-referrer")
          .redirect(`${c.baseUrl}/#${fragment}`, 302);

      app.get<{ Params: { provider: string } }>("/api/auth/oidc/:provider/start", async (req, reply) => {
        const provider = req.params.provider;
        const client = clients.get(provider);
        if (!client) return reply.code(404).send({ error: "not_found" });
        sweep();
        if (pending.size >= MAX_PENDING) return back(reply, "sa_login_error=busy");
        const state = newToken();
        const nonce = newToken();
        const verifier = newToken();
        let url: string;
        try {
          url = await client.authorizeUrl({ state, nonce, verifier });
        } catch (e) {
          log("oidc start failed", { provider, reason: reasonOf(e) });
          return back(reply, "sa_login_error=unavailable");
        }
        pending.set(state, { provider, nonce, verifier, expires: now() + STATE_TTL_MS });
        return reply
          .header("set-cookie", cookie(state, STATE_TTL_MS / 1000))
          .header("cache-control", "no-store")
          .redirect(url, 302);
      });

      app.get<{ Params: { provider: string }; Querystring: Record<string, unknown> }>(
        "/api/auth/oidc/:provider/callback",
        async (req, reply) => {
          const provider = req.params.provider;
          const client = clients.get(provider);
          if (!client) return reply.code(404).send({ error: "not_found" });
          reply.header("set-cookie", cookie("", 0));
          const { state, code, error } = req.query;
          const fromCookie = readCookie(req);
          const p = typeof state === "string" ? pending.get(state) : undefined;
          if (typeof state === "string") pending.delete(state);
          if (
            typeof state !== "string" || !fromCookie || !same(state, fromCookie) ||
            !p || p.provider !== provider || p.expires <= now()
          )
            return back(reply, "sa_login_error=expired");
          if (error !== undefined || typeof code !== "string" || code.length === 0)
            return back(reply, "sa_login_error=cancelled");
          let claims: Awaited<ReturnType<OidcClient["redeem"]>>;
          try {
            claims = await client.redeem(code, p.verifier, p.nonce);
          } catch (e) {
            log("oidc callback failed", { provider, reason: reasonOf(e) });
            return back(reply, "sa_login_error=failed");
          }
          const r = await resolveUser(db, provider, claims, c.allow, client.cfg.spec.domainClaim);
          if (!r.ok) {
            log("oidc login refused", { provider, reason: r.reason });
            return back(reply, `sa_login_error=${r.reason}`);
          }
          if (r.created) {
            log("oidc user created", { user: r.userId, provider });
            await joinSeedRooms(db, hooks, log, r.userId);
          }
          sweep();
          const loginCode = newToken();
          codes.set(hashToken(loginCode), {
            userId: r.userId, displayName: r.displayName, provider, expires: now() + CODE_TTL_MS,
          });
          return back(reply, `sa_login=${loginCode}`);
        },
      );

      app.post("/api/auth/oidc/exchange", async (req, reply) => {
        const body = OidcExchangeRequest.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const key = hashToken(body.data.code);
        const entry = codes.get(key);
        codes.delete(key);
        if (!entry || entry.expires <= now()) return reply.code(401).send({ error: "expired" });
        const token = newToken();
        await db.query(
          "insert into sa.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(hours => $3))",
          [hashToken(token), entry.userId, SESSION_HOURS],
        );
        log("login", { user: entry.userId, method: entry.provider });
        const res: LoginResponse = { token, user: { id: entry.userId, display_name: entry.displayName } };
        return res;
      });
    },
  };
}

export const plugin = createOidcPlugin();
```

If Fastify 5's typings reject `Querystring: Record<string, unknown>`, the `redirect(url, code)` order or the `preSerialization` signature, adapt only the typing or the argument order. The behaviour must not change.

Tests (`services/bridge/test/oidc-routes.test.ts`). Use pglite with user `ana` (PIN `123456`, email `ana@example.com`), and `buildApp({ db, relayAdmin: fake, plugins: [createOidcPlugin({ env, fetch: fake.fetch, now: () => t })] })` with `env = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", AUTH_ALLOWED_EMAILS: "ana@example.com,new@example.com", PUBLIC_BASE_URL: "https://demo.example" }`. Helper `signIn(user)`: GET `start`, take `set-cookie` + `location`, `fake.authorize(location, user)`, GET `callback?code&state` with `cookie: sa_oidc=<state>`, and return the `location`.
- **Disabled:** with `env = {}`, `/api/auth/providers` → `{pin:true, oidc:[]}`, `start` → 404, and `fake.calls` stays empty, even after `/api/login` and `/api/users`.
- **Enabled:** building the app makes no fetch (`fake.calls` empty until the first `start`).
- **Round trip:** `signIn(new)` ends at `https://demo.example/#sa_login=<code>`. The cookie had `HttpOnly`, `SameSite=Lax` and `Secure`. Exchanging the code returns a token that works on `GET /api/chats` (200). The same code again → 401.
- A login code exchanged 61 s later (advance `t`) → 401 `expired`.
- A callback without the cookie, with a different cookie value, or replaying a used state ends at `#sa_login_error=expired`, and the token endpoint is not called (count `calls`).
- `?error=access_denied&state=<valid>` with the cookie → `#sa_login_error=cancelled`.
- `out@example.org` → `#sa_login_error=not_allowed`, and no `sa.users` row is created.
- PIN login for `ana` still works with Google enabled, and `signIn(ana@example.com)` signs in as `ana`.
- **First run:** insert a seeded room (`kind 'room'`, `seed_key 'general'`, `history_until_seq 5`, `created_by 'ana'`) and a plain room, and pass `buildApp({ …, hooks: { onMemberAdded: spy } })`. `signIn(new)` makes the new user an active member of the seeded room only, and `spy` is called once with (`seededId`, the new id). A second sign-in calls it no more.
- **Picker:** `GET /api/users` lists `ana` but not the Google-created user, with Google enabled and also with `env = {}`.

### G5: Web: Google button, fragment exchange, D-14 copy and badge

`apps/web/src/api.ts`:
- Add `authProviders = () => api<AuthProviders>("/auth/providers")` and `oidcExchange = (code: string) => api<LoginResponse>("/auth/oidc/exchange", json("POST", { code }))` (import `AuthProviders` from `@sa/protocol`).
- The 401 auto-reload must skip auth paths: `if (res.status === 401 && path !== "/login" && !path.startsWith("/auth/"))`.

`apps/web/src/auth/oidc.ts`:

```ts
export type LoginReturn = { code: string } | { error: string } | null;

/** Reads the sign-in result the bridge put in the URL fragment and removes it from the address bar. */
export function takeLoginReturn(loc: Location = location, hist: History = history): LoginReturn {
  const h = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const code = h.get("sa_login");
  const error = h.get("sa_login_error");
  if (!code && !error) return null;
  hist.replaceState(null, "", loc.pathname + loc.search);
  return code ? { code } : { error: error ?? "failed" };
}

const LOGIN_ERRORS: Record<string, string> = {
  not_allowed: "This account is not allowed here. Ask the admin to add your email.",
  conflict: "This email is already linked to a different sign-in. Ask the admin.",
  expired: "The sign-in took too long or started in another tab. Try again.",
  cancelled: "Sign-in was cancelled.",
  busy: "Too many sign-ins at once. Wait a minute, then try again.",
};
export const loginErrorText = (code: string): string => LOGIN_ERRORS[code] ?? "Sign-in failed. Try again.";
```

`apps/web/src/pages/Login.tsx` (the ds-styled version from the T1 plan; keep every existing label and button name):
- On mount, also call `authProviders()`. On any failure, treat it as `{pin:true, oidc:[]}`; it is never an error message.
- For each OIDC provider, render a link above the user picker: `<a href={`/api/auth/oidc/${p.id}/start`}>Sign in with {p.label}</a>`, styled with the ds primary button classes. When both are shown, put a muted divider "or pick a demo user" before the picker.
- Fragment handling runs in a `useEffect` guarded by a `useRef` (`started.current`). Run it once, and do not cancel in the cleanup, because StrictMode double-invokes effects. Call `takeLoginReturn()`:
  - `{code}`: set busy and show "Signing in…". Call `oidcExchange(code)`, then `setSession(s)` and `onSignedIn(s)`. On failure show `loginErrorText(status === 401 ? "expired" : "failed")`.
  - `{error}`: show `loginErrorText(error)` in the existing `role="alert"` paragraph.
- After a successful exchange the path stays `/`, so the T20 router sends a new user to `/welcome`.
- Under the Google link, show the D-14 line `GOOGLE_TRUST_LINE` in muted text.

D-14 copy. In `apps/web/src/auth/oidc.ts` also export:

```ts
import { useEffect, useState } from "react";
import type { AuthProviders } from "@sa/protocol";
import { authProviders } from "../api";

export const GOOGLE_TRUST_LINE = "Sign-in uses Google · chats and AI stay on this Mac";
let cached: Promise<AuthProviders> | undefined;
/** Providers the bridge offers; any failure means PIN only. Fetched once per page load. */
export function useAuthProviders(): AuthProviders {
  const [p, setP] = useState<AuthProviders>({ pin: true, oidc: [] });
  useEffect(() => {
    cached ??= authProviders().catch(() => ({ pin: true, oidc: [] }));
    void cached.then(setP);
  }, []);
  return p;
}
/** test hook */
export const resetAuthProvidersCache = () => {
  cached = undefined;
};
```

Login uses `useAuthProviders()` instead of its own fetch. Tests call `resetAuthProvidersCache()` in `beforeEach`.
- `apps/web/src/shell/TopBar.tsx`: when `useAuthProviders().oidc.length > 0`, the trust strip text is `GOOGLE_TRUST_LINE`; otherwise it stays as it is.
- `apps/web/src/pages/PresenterPage.tsx`: when OIDC is listed, render `<span role="status">Google sign-in on</span>` in the header, styled with the ds warning pill (amber), with `title` "Sign-in contacts Google; chats and AI stay on this Mac".

Tests (`apps/web/test/login-oidc.test.tsx`; render `<App />` with the same fetch stub style as `login.test.tsx`):
- `/api/auth/providers` → `{pin:true, oidc:[{id:"google",label:"Google"}]}`: a link named "Sign in with Google" has `href="/api/auth/oidc/google/start"`.
- `/api/auth/providers` → 404: there is no such link, and the PIN picker still lists Ana.
- With `history.replaceState(null, "", "/#sa_login=abcdefghijklmnopqrstuvwxyz")`: `POST /api/auth/oidc/exchange` is called with that code. `sessionStorage["sa.session"]` then holds the token, and `location.hash` is `""`.
- With `#sa_login_error=not_allowed`, the alert shows "This account is not allowed here. Ask the admin to add your email."
- With Google listed, the login page shows "Sign-in uses Google · chats and AI stay on this Mac". Without it, that line is absent.
- `apps/web/test/presenter.test.tsx` (extend): with Google listed, a status badge "Google sign-in on" renders. With `/api/auth/providers` → 404, it does not.
- `apps/web/test/shell.test.tsx` (extend): `TopBar` shows the D-14 line when Google is listed, and the usual trust strip otherwise.

### G6: Operator doc

`docs/auth.md` gets these sections: "Sign-in methods" (demo PIN always; Google off by default), "Enable Google sign-in" (the env list and the steps copied from this plan's "Before the run (human)" section, unchanged), "Redirect URIs" (one per base URL, exact match), "Who may sign in" (email list; domain list requires a Workspace `hd`; Testing-mode test users; removing an email blocks at next sign-in), "Linking a demo user" (`SA_DEMO_EMAILS` + `make seed`), "Privacy and network" (device keys never leave the browser; the bridge contacts Google only during a sign-in; nothing at startup; D-14: this is the only deliberate egress, the UI says "Sign-in uses Google · chats and AI stay on this Mac", the Presenter shows a "Google sign-in on" badge, and `make smoke` allowlists only the three Google OAuth hosts on 443 while enabled) and "Adding another provider" (one `OidcProviderSpec` in `services/bridge/src/oidc/providers.ts` plus its env names in `config.ts`; use the same `/api/auth/oidc/<id>/callback` shape when hosting elsewhere). Use only `example.com` addresses and `<placeholders>`.

`README.md`: in the commands/usage section, add one line: `Optional Google sign-in: see docs/auth.md (off unless .env enables it).`

### G7: Egress guard allowlist (D-14)

`infra/py/src/sa_infra/egress.py`: add the following and change `offending`/`scan` (existing callers keep working, because `allow` defaults to empty):

```python
import socket
from collections.abc import Callable, Mapping
from pathlib import Path

GOOGLE_OAUTH_HOSTS = ("accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com")


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=VALUE lines of a .env file; comments and blank lines ignored."""
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip("\"'")
    return out


def google_oauth_enabled(env: Mapping[str, str]) -> bool:
    """Mirrors services/bridge/src/oidc/config.ts: id, secret, base URL and an allowlist."""

    def has(k: str) -> bool:
        return bool(env.get(k, "").strip())

    return (
        has("GOOGLE_CLIENT_ID")
        and has("GOOGLE_CLIENT_SECRET")
        and has("PUBLIC_BASE_URL")
        and (has("AUTH_ALLOWED_EMAILS") or has("AUTH_ALLOWED_DOMAINS"))
    )


def resolve_ips(
    hosts: Iterable[str], resolver: Callable[..., list] = socket.getaddrinfo
) -> frozenset[str]:
    ips: set[str] = set()
    for host in hosts:
        try:
            infos = resolver(host, 443, proto=socket.IPPROTO_TCP)
        except OSError:
            continue
        ips.update(str(info[4][0]).split("%", 1)[0] for info in infos)
    return frozenset(ips)


def offending(conns: Iterable[Conn], allow: frozenset[str] = frozenset()) -> list[Conn]:
    return [
        c
        for c in conns
        if c.remote_ip
        and not is_loopback(c.remote_ip)
        and not (c.remote_port == 443 and c.remote_ip.split("%", 1)[0] in allow)
    ]


def scan(
    pids: Iterable[int], *, include_children: bool = True, allow: frozenset[str] = frozenset()
) -> list[Conn]:
    return offending(collect(pids, include_children=include_children), allow)
```

`infra/py/tests/live/test_90_guards.py`: before the scan, build `env = {**egress.read_env_file(models_config.REPO_ROOT / ".env"), **os.environ}` (import `models_config` from `sa_infra`). Then `allow = egress.resolve_ips(egress.GOOGLE_OAUTH_HOSTS) if egress.google_oauth_enabled(env) else frozenset()`, `print(f"egress allowlist: {len(allow)} Google OAuth IPs")`, and `bad = egress.scan({...}, allow=allow)`. Nothing is resolved when Google is off.

Tests (`infra/py/tests/test_egress.py`, add):
- `offending` with `allow={"142.250.1.1"}` passes `Conn(.., "142.250.1.1", 443)` but flags the same IP on port 80 and `8.8.8.8:443`. With the default empty allow, the existing cases are unchanged.
- `google_oauth_enabled`: false for `{}`, for an id and secret alone, and for an id, secret and allowlist without `PUBLIC_BASE_URL`; true with all four. `read_env_file` on a tmp file with comments, blanks and quoted values.
- `resolve_ips(["a.example"], resolver=fake)` returns the fake's IPs, and a resolver raising `OSError` yields an empty set.

```relay-plan
{
  "slug": "sa-google-login",
  "suite": "make check",
  "setup": "pnpm install --frozen-lockfile && uv sync",
  "tasks": [
    {
      "id": "G1",
      "title": "Shapes, migration, config, provider spec, dependency",
      "tier": "cheap",
      "code": "complete",
      "risk": "medium",
      "files": [
        "packages/protocol/src/index.ts",
        "services/bridge/src/migrations/005_identity.sql",
        "services/bridge/src/oidc/providers.ts",
        "services/bridge/src/oidc/config.ts",
        "services/bridge/test/oidc-config.test.ts",
        "services/bridge/package.json",
        "pnpm-lock.yaml",
        ".env.example"
      ],
      "deps": [],
      "behaviors": [
        "Google sign-in is off unless client id, secret, a valid PUBLIC_BASE_URL and an allowlist are all set",
        "the redirect URI is derived from PUBLIC_BASE_URL only",
        "SA_DEMO_EMAILS parses to lowercased user-id/email pairs"
      ],
      "tests": 3,
      "done": "pnpm --filter @sa/protocol typecheck && pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/oidc-config.test.ts"
    },
    {
      "id": "G2",
      "title": "OIDC client and fake provider",
      "tier": "mid",
      "code": "complete",
      "risk": "high",
      "files": [
        "services/bridge/src/oidc/client.ts",
        "services/bridge/test/fake-oidc.ts",
        "services/bridge/test/oidc-client.test.ts"
      ],
      "deps": [
        "G1"
      ],
      "behaviors": [
        "authorize URL carries state, nonce and an S256 PKCE challenge",
        "the code is redeemed with the PKCE verifier",
        "ID tokens with wrong aud, iss, nonce, azp, expired exp or non-RS256 alg are rejected",
        "an unknown signing key triggers one JWKS refetch"
      ],
      "tests": 9,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/oidc-client.test.ts"
    },
    {
      "id": "G3",
      "title": "User mapping and demo email linking",
      "tier": "cheap",
      "code": "complete",
      "risk": "high",
      "files": [
        "services/bridge/src/oidc/users.ts",
        "services/bridge/src/seed.ts",
        "services/bridge/test/oidc-users.test.ts"
      ],
      "deps": [
        "G1"
      ],
      "behaviors": [
        "first login of an allowed verified email creates a user",
        "an existing person with that email is linked instead",
        "a second subject for a linked email is a conflict",
        "unverified, unlisted, hd-less domain and seed-colleague logins are refused, also for already linked users"
      ],
      "tests": 7,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/oidc-users.test.ts"
    },
    {
      "id": "G4",
      "title": "OIDC plugin: start, callback, exchange",
      "tier": "mid",
      "code": "complete",
      "risk": "high",
      "files": [
        "services/bridge/src/plugins/oidc.ts",
        "services/bridge/test/oidc-routes.test.ts"
      ],
      "deps": [
        "G2",
        "G3"
      ],
      "behaviors": [
        "disabled: providers list is empty, OIDC routes 404, zero outbound fetches",
        "enabled: no fetch until the first sign-in",
        "a full sign-in yields a one-time 60 s code that exchanges for a bearer session",
        "callbacks without the matching state cookie, replayed or expired states never reach the token endpoint",
        "cancelled and not-allowed sign-ins return to the app with an error code",
        "PIN login keeps working with Google enabled",
        "a Google-created user joins every seeded room through the workspace grant hook, never other rooms",
        "users without a PIN are not listed in the PIN picker"
      ],
      "tests": 10,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/oidc-routes.test.ts test/bridge.test.ts"
    },
    {
      "id": "G5",
      "title": "Web: Google button, fragment exchange, D-14 copy and badge",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "apps/web/src/api.ts",
        "apps/web/src/auth/oidc.ts",
        "apps/web/src/pages/Login.tsx",
        "apps/web/test/login-oidc.test.tsx",
        "apps/web/src/shell/TopBar.tsx",
        "apps/web/src/pages/PresenterPage.tsx",
        "apps/web/test/presenter.test.tsx",
        "apps/web/test/shell.test.tsx"
      ],
      "deps": [
        "G1"
      ],
      "behaviors": [
        "a Sign in with Google link shows when the bridge lists the provider",
        "without providers the login screen is the PIN picker exactly as before",
        "a returned login code is exchanged once, stored as the session and removed from the URL",
        "a returned error code shows a plain-English message",
        "with Google on, login page and trust strip say Sign-in uses Google · chats and AI stay on this Mac",
        "with Google on, the Presenter page shows a Google sign-in on badge"
      ],
      "tests": 6,
      "done": "pnpm --filter @sa/web typecheck && pnpm --filter @sa/web exec vitest run test/login-oidc.test.tsx test/login.test.tsx test/api.test.ts test/presenter.test.tsx test/shell.test.tsx"
    },
    {
      "id": "G6",
      "title": "Operator doc",
      "tier": "cheap",
      "code": "prose",
      "risk": "low",
      "files": [
        "docs/auth.md",
        "README.md"
      ],
      "deps": [],
      "behaviors": [
        "the operator can create the Google OAuth client and enable sign-in from the doc alone"
      ],
      "tests": 0,
      "done": "test -s docs/auth.md && grep -q '/api/auth/oidc/google/callback' docs/auth.md && ! git grep -inE 'real[t]yme|gate[x]'"
    },
    {
      "id": "G7",
      "title": "Egress guard allowlist (D-14)",
      "tier": "cheap",
      "code": "complete",
      "risk": "medium",
      "files": [
        "infra/py/src/sa_infra/egress.py",
        "infra/py/tests/test_egress.py",
        "infra/py/tests/live/test_90_guards.py"
      ],
      "deps": [],
      "behaviors": [
        "with Google off, the smoke egress allowlist is empty and nothing is resolved",
        "with Google on, only the three Google OAuth hosts on port 443 are allowed",
        "the guard reads the same env names as the bridge, from .env or the environment"
      ],
      "tests": 3,
      "done": "uv run pytest infra/py/tests/test_egress.py && uv run ruff check infra/py"
    }
  ]
}
```
