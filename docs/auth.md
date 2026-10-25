# Sign-in

## Sign-in methods

- **Demo PIN** is always on. `make seed` prints each demo user's PIN once.
- **Google** is off by default. It turns on only when `.env` holds a client ID, a secret, a base URL and an allowlist.

## Enable Google sign-in

1. Open https://console.cloud.google.com and create (or pick) a project with a neutral name, for example `sovereign-agents-demo`.
2. **Google Auth Platform → Branding:** set the app name ("Sovereign Agents") and the support email. **Audience:** choose *Internal* if every user is in your Google Workspace domain. Otherwise choose *External* and leave it in **Testing**, then add each person under *Test users*. In Testing mode Google itself refuses anyone not listed, which acts as a second allowlist. **Data access:** add only `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. These are non-sensitive scopes, so no verification is needed.
3. **Clients → Create client → Web application.** Leave *Authorized JavaScript origins* empty, because the flow is server-side. Under *Authorized redirect URIs*, add each base URL you will use, exactly (scheme, host, port, no trailing slash):
   - `http://localhost:5173/api/auth/oidc/google/callback` (local `make dev`)
   - `https://<mac-name>.<tailnet>.ts.net/api/auth/oidc/google/callback` (after `make share`; `tailscale serve status` prints the name)
   - later, `https://<aws-host>/api/auth/oidc/google/callback`
4. Copy the client ID and secret into `.env` (gitignored; never commit it):
   ```
   PUBLIC_BASE_URL=https://<mac-name>.<tailnet>.ts.net   # or http://localhost:5173
   GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=<secret>
   AUTH_ALLOWED_EMAILS=you@example.com,colleague@example.com
   AUTH_ALLOWED_DOMAINS=                                   # optional, Workspace domains only
   SA_DEMO_EMAILS=ana:you@example.com                      # optional: link a demo user, then `make seed`
   ```
5. Restart `make dev`, open `PUBLIC_BASE_URL` (the same origin you registered) and click **Sign in with Google**. Google never needs to reach the Mac: the browser carries the redirect, and the bridge calls `accounts.google.com`, `oauth2.googleapis.com` and `www.googleapis.com` outbound only during a sign-in. With these values in `.env`, `make smoke` allowlists those three hosts (D-14); remove them to return to strict 0-egress.

## Redirect URIs

Register one per base URL you use. Google matches exactly: scheme, host, port and path, no trailing slash. The path is always `/api/auth/oidc/google/callback`. Use the Tailscale HTTPS name for shared demos and the localhost one as the local fallback. `PUBLIC_BASE_URL` must be the origin you opened.

## Who may sign in

- `AUTH_ALLOWED_EMAILS`: a comma-separated list of exact addresses.
- `AUTH_ALLOWED_DOMAINS`: whole domains. This works only for Google Workspace accounts, because the token must carry the `hd` (hosted domain) claim.
- In Testing mode, Google also refuses anyone not listed under *Test users*.
- Removing an email from the list blocks that person at their next sign-in. A session already open lasts until it expires.

## Linking a demo user

Set `SA_DEMO_EMAILS=<demo-user>:<email>` (for example `ana:you@example.com`, comma-separated for several), then run `make seed`. That Google account signs in as the existing demo user.

## Privacy and network

- Device keys never leave the browser. Google sees only that you signed in.
- The bridge contacts Google only during a sign-in, never at startup.
- D-14: this is the only deliberate egress. The sign-in page says "Sign-in uses Google · chats and AI stay on this Mac", the Presenter shows a "Google sign-in on" badge, and while enabled `make smoke` allowlists only the three Google OAuth hosts on port 443.
- PIN login stays on either way, so the demo works offline.

## Adding another provider

Add one `OidcProviderSpec` in `services/bridge/src/oidc/providers.ts` and its env names in `services/bridge/src/oidc/config.ts`. Keep the same callback shape, `/api/auth/oidc/<id>/callback`, when hosting elsewhere, and register that URI with the provider.
