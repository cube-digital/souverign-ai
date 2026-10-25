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
