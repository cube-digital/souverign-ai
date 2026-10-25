import { timingSafeEqual } from "node:crypto";
import { type AuthProviders, type LoginResponse, OidcExchangeRequest } from "@sa/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { BridgeHooks } from "../agents/api.js";
import { hashToken, newToken, SESSION_HOURS } from "../auth.js";
import type { Db } from "../db.js";
import { type Fetch, OidcClient, OidcError } from "../oidc/client.js";
import { type AuthConfig, loadAuthConfig } from "../oidc/config.js";
import { resolveUser } from "../oidc/users.js";
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
        if (
          req.method !== "GET" ||
          req.routeOptions.url !== "/api/users" ||
          !Array.isArray(payload)
        )
          return payload;
        const rows = await db.query<{ id: string }>(
          "select id from sa.users where pin_hash = 'disabled'",
        );
        const hidden = new Set(rows.map((r) => r.id));
        return payload.filter(
          (u: { id?: unknown }) => !(typeof u?.id === "string" && hidden.has(u.id)),
        );
      });
      if (clients.size === 0) return;

      // Modest per-client rate limit on the OIDC routes.
      const hits = new Map<string, { n: number; reset: number }>();
      app.addHook("onRequest", async (req, reply) => {
        if (!req.url.startsWith("/api/auth/oidc/")) return;
        const t = now();
        if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
        const h = hits.get(req.ip);
        if (!h || h.reset <= t) hits.set(req.ip, { n: 1, reset: t + 60_000 });
        else if (++h.n > 60) return reply.code(429).send({ error: "rate_limited" });
      });

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

      app.get<{ Params: { provider: string } }>(
        "/api/auth/oidc/:provider/start",
        async (req, reply) => {
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
        },
      );

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
            typeof state !== "string" ||
            !fromCookie ||
            !same(state, fromCookie) ||
            !p ||
            p.provider !== provider ||
            p.expires <= now()
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
          // The domain claim only vouches for domain allowlist entries; with an emails-only allowlist
          // the listed address itself is the trust anchor (the acceptance test signs in without hd).
          const domainClaim = c.allow.domains.size > 0 ? client.cfg.spec.domainClaim : undefined;
          const r = await resolveUser(db, provider, claims, c.allow, domainClaim);
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
            userId: r.userId,
            displayName: r.displayName,
            provider,
            expires: now() + CODE_TTL_MS,
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
        const res: LoginResponse = {
          token,
          user: { id: entry.userId, display_name: entry.displayName },
        };
        return res;
      });
    },
  };
}

export const plugin = createOidcPlugin();
