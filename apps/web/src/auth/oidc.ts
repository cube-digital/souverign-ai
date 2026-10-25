import type { AuthProviders } from "@sa/protocol";
import { useEffect, useState } from "react";
import { authProviders } from "../api";

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
export const loginErrorText = (code: string): string =>
  LOGIN_ERRORS[code] ?? "Sign-in failed. Try again.";

export const GOOGLE_TRUST_LINE = "Sign-in uses Google · chats and AI stay on this Mac";
const PIN_ONLY: AuthProviders = { pin: true, oidc: [] };
let cached: Promise<AuthProviders> | undefined;
/** Providers the bridge offers; any failure or odd answer means PIN only. Fetched once per page load. */
export function useAuthProviders(): AuthProviders {
  const [p, setP] = useState<AuthProviders>(PIN_ONLY);
  useEffect(() => {
    cached ??= Promise.resolve()
      .then(() => authProviders())
      .then((r) => (Array.isArray(r?.oidc) ? r : PIN_ONLY))
      .catch(() => PIN_ONLY);
    void cached.then(setP);
  }, []);
  return p;
}
/** test hook */
export const resetAuthProvidersCache = () => {
  cached = undefined;
};
