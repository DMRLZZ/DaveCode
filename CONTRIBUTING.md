# Contributing to DaveCode

Thanks for helping build DaveCode! This guide covers the workflow we use day to day.

## Development setup

Requirements: **Node.js 22.12+** (see `.nvmrc`) and **pnpm 10+** (`corepack enable` works).

```bash
pnpm install        # install all workspace dependencies
pnpm build          # build every package
pnpm test           # run the Vitest suite
pnpm typecheck      # strict TypeScript across packages
pnpm lint           # Biome lint + format check (pnpm lint:fix to apply)
pnpm check          # everything CI runs
```

`pnpm dev` starts the gateway with hot reload; `pnpm dev:ui` starts the dashboard dev server.
Workspace packages resolve to their TypeScript sources during tests and dev through the `source`
export condition, so you rarely need to rebuild while iterating.

## Project structure

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The short version:

- `packages/core`: everything that is not I/O-facing UI. **Never import from other packages.**
- `packages/server`: HTTP surface only; business logic belongs in `core`.
- `packages/cli`: commands and the TUI.
- `packages/ui`: the dashboard, which talks to the server over HTTP only.

Shared contracts live in `packages/core/src/types.ts`. If you change a shape there, update
[docs/API.md](docs/API.md) in the same PR.

## Branches, commits and pull requests

- Branch from `main` using a descriptive prefix: `feat/…`, `fix/…`, `docs/…`, `chore/…`,
  `refactor/…`, `test/…`.
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(core): add sliding-window tracker`, `fix(server): close SSE on client abort`.
- Keep commits focused: one logical change per commit, and each commit should build. Avoid both
  "giant dump" commits and one-line noise commits.
- Open a PR against `main` and fill in the template. CI (lint, typecheck, test, build) must be
  green before merge.
- Add or update tests for behaviour changes. Bug fixes should come with a regression test.

## Coding guidelines

- TypeScript strict mode; avoid `any`. Prefer narrow types and zod schemas at trust boundaries
  (config files, HTTP bodies, task graphs, provider responses).
- Never log or emit secrets. Account secrets are write-only and must stay inside the keyring.
- Keep provider adapters behind the `Provider` interface and map upstream failures to
  `ProviderError` kinds so the router can fail over correctly.
- Features that may break a provider's Terms of Service must be behind an `experimental.*` flag,
  off by default, and documented in the README.

## Reporting bugs and requesting features

Use the GitHub issue templates. For security vulnerabilities, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
