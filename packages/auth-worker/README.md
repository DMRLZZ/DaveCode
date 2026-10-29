# DaveCode accounts (Cloudflare Worker)

Sign-in for `davecode login`: Google, GitHub or email with a password, served from
Cloudflare Workers with a D1 database. The browser only ever sees pages on
`auth.davecode.app`; the CLI talks to the service through `AccountClient` in `@davecode/core`.

## How a sign-in works

1. `davecode login` starts a one-shot listener on 127.0.0.1 (random port and path) and opens
   `/login?redirect_to=<listener>&code_challenge=<PKCE>` here.
2. Google or GitHub: the page links to `/auth/v1/authorize`, then the provider, then
   `/auth/v1/callback/:provider`, which redirects to the listener with a one-time code bound to
   the CLI's PKCE challenge.
3. Email: the page's form posts to `/login`. Sign-in redirects to the listener with a code;
   sign-up emails a link (`/auth/v1/verify`) that does the same once the address is confirmed.
4. The CLI exchanges the code at `/auth/v1/token?grant_type=pkce`, sends the browser to
   `/login/done` (or `/login/failed`), stores the session encrypted and refreshes it with
   `grant_type=refresh_token` (rotating; reuse revokes the session).

Only loopback redirects are accepted, codes and links are single use and expire, every token is
stored hashed, passwords use PBKDF2-SHA256, and sign-in and sign-up are rate limited per IP.

## Deploy

```bash
pnpm --filter @davecode/auth-worker build     # dist/worker.js
npx wrangler deploy                            # from packages/auth-worker
```

The D1 database id is in `wrangler.jsonc`. On a new database, create the tables first (the
statements in `src/schema.ts`, idempotent). Secrets are never committed:

| Secret                                     | Where it comes from                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`                               | Random, at least 32 bytes. Rotating it signs everyone out.                                                                       |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub → Settings → Developer settings → OAuth Apps. Callback: `https://auth.davecode.app/auth/v1/callback/github`               |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud → APIs & Services → Credentials → OAuth client (Web). Redirect: `https://auth.davecode.app/auth/v1/callback/google` |

`/auth/v1/settings` reports which methods are enabled; the CLI only offers those. Email needs
Cloudflare Email Sending enabled for `davecode.app`.
