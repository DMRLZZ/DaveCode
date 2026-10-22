# Google and GitHub sign-in

App sign-in identifies users allowed to control this workspace. It does not connect
AI subscriptions. Local use remains available when login is disabled; existing API
bearer protection is preserved.

Create an OAuth web app with Google and/or GitHub. Register the exact callback:

- `http://localhost:4040/api/auth/google/callback`
- `http://localhost:4040/api/auth/github/callback`

Set variables in the gateway environment, never in a Vite/browser config:

```text
DAVECODE_LOGIN_ENABLED=1
DAVECODE_PUBLIC_ORIGIN=http://localhost:4040
DAVECODE_GOOGLE_CLIENT_ID=<web client ID>
DAVECODE_GOOGLE_CLIENT_SECRET=<client secret>
DAVECODE_GITHUB_CLIENT_ID=<OAuth app ID>
DAVECODE_GITHUB_CLIENT_SECRET=<client secret>
DAVECODE_LOGIN_ALLOWED_USERS=github:123456,google:stable-subject
```

Configure only the providers you need. The allowlist uses numeric GitHub user IDs
and Google `sub` values from the provider's authenticated profile tools, not email
addresses or usernames. Missing credentials or an empty allowlist fail startup.
Never paste secrets into chat or commit them.

Open the UI on the canonical origin. Hosted gateways require HTTPS. The public
landing page is separate from the local app. Cross-origin cookie deployments,
team roles and multi-user project isolation are outside this first version.

State is bound to an HttpOnly browser cookie; PKCE S256 protects the code exchange.
Pending requests expire after ten minutes. Provider tokens are discarded after
profile lookup. Responses are validated and upstream errors are sanitized.
Sessions last eight hours, are held in memory and expire on restart. Cookies use
HttpOnly, SameSite=Lax and Secure on HTTPS. Cookie-authenticated writes require the
canonical Origin. `/v1` still needs a configured bearer token. Signing out revokes
the local session; it does not sign the user out of Google or GitHub.

Tests mock provider responses and cover both providers, browser binding, replay,
expiry, allowlists, cookies, CSRF and API protection. Real sign-in still needs your
OAuth client setup and an interactive verification; that has not been performed.

References: [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).
