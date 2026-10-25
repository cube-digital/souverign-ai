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
    if (!id || !secret)
      warnings.push("google: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both required");
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
    const email = part
      .slice(i + 1)
      .trim()
      .toLowerCase();
    if (id && email.includes("@")) out.set(id, email);
  }
  return out;
}
