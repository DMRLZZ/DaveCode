# DaveCode accounts (Cloudflare Worker)

Sign-in for `davecode login`: Google, GitHub or email with a password, served from
Cloudflare Workers with a D1 database. The CLI talks to it through `AccountClient` in
`@davecode/core`; the browser page the user sees is served by the CLI itself on 127.0.0.1.

## How a sign-in works

1. `davecode login` starts a one-shot server on 127.0.0.1 and opens its page.
2. Google or GitHub: the page sends the browser to `/auth/v1/authorize` here, then to the
   provider, then back to `/auth/v1/callback/:provider`, which redirects to the CLI's loopback
   callback with a one-time code bound to the CLI's PKCE challenge.
3. Email: the CLI posts to `/auth/v1/signup`; the emailed link (`/auth/v1/verify`) confirms the
   address and returns to the loopback callback the same way. Later sign-ins use
   `/auth/v1/token?grant_type=password`.
4. The CLI exchanges the code at `/auth/v1/token?grant_type=pkce`, stores the session encrypted
   and refreshes it with `grant_type=refresh_token` (rotating; reuse revokes the session).

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
