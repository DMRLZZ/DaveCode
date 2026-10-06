# DaveCode: architecture (project brain)

Condensed context injected into autonomous tasks. The full document is
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

- **Stack:** Node ≥ 22.12, TypeScript strict, ESM, pnpm workspaces, tsup, Vitest, Biome.
- **Packages:** `core` (all domain logic, imports nothing internal), `server` (Fastify HTTP
  only), `cli` (commander + Ink), `ui` (Vite + React + Tailwind, HTTP only).
- **Contracts:** `packages/core/src/types.ts` and `events.ts` are the source of truth;
  `docs/API.md` must match them.
- **Storage:** `better-sqlite3` in WAL mode at `~/.davecode/state.db`; secrets encrypted with
  AES-256-GCM, write-only through the API.
- **Errors:** providers throw `ProviderError` with a `kind`; `failover` kinds trigger rerouting.
- **Events:** everything observable goes through `EventBus` → SSE `/api/events`. No secrets in
  events.
- **Safety:** ToS-sensitive features stay behind `experimental.*` flags (default off).
- **Quality gates:** `pnpm lint`, `pnpm typecheck`, `pnpm test` must exit 0 before merge.
