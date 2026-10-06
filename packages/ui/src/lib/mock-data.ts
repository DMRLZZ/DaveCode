import type { Account, QuotaLimits, Route, TaskNode } from './types';

/**
 * Static fixtures for mock mode. The project shown is DaveCode building itself (dogfooding
 * its own `.davecode/` brain), so screenshots tell a coherent story.
 */

export interface MockAccountSeed {
  account: Omit<Account, 'createdAt' | 'updatedAt' | 'status'> & { status?: Account['status'] };
  /** Utilization curve for rolling windows: starts at `from`, eases towards `to`. */
  curve5h: { from: number; to: number };
  curve24h: { from: number; to: number };
  /** Base latency (ms) and per-output-token cost (ms). */
  latency: [number, number];
  /** Chance an attempt fails with each error kind, before quota pressure is applied. */
  failRate: number;
}

const limits = (l: QuotaLimits) => l;

export const ACCOUNT_SEEDS: MockAccountSeed[] = [
  {
    account: {
      id: 'acc_claude_pro',
      provider: 'claude-cli',
      label: 'Claude Pro — personal',
      enabled: true,
      priority: 10,
      weight: 3,
      limits: limits({ tpm: 60_000, tokens5h: 3_000_000, requests5h: 900, tokensDaily: 9_000_000 }),
      config: { binary: 'claude', sandbox: '~/.davecode/sandboxes/acc_claude_pro' },
    },
    curve5h: { from: 0.79, to: 0.935 },
    curve24h: { from: 0.54, to: 0.63 },
    latency: [900, 11],
    failRate: 0.02,
  },
  {
    account: {
      id: 'acc_anthropic_work',
      provider: 'anthropic',
      label: 'Anthropic API — work',
      enabled: true,
      priority: 20,
      weight: 2,
      limits: limits({ tpm: 120_000, rpm: 50, tokens5h: 6_000_000, tokensDaily: 20_000_000 }),
      config: { models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5'] },
    },
    curve5h: { from: 0.48, to: 0.64 },
    curve24h: { from: 0.36, to: 0.44 },
    latency: [650, 9],
    failRate: 0.015,
  },
  {
    account: {
      id: 'acc_openai_team',
      provider: 'openai',
      label: 'OpenAI — team',
      enabled: true,
      priority: 30,
      weight: 1,
      limits: limits({ tpm: 90_000, rpm: 60, tokens5h: 5_000_000, tokensDaily: 15_000_000 }),
      config: { models: ['gpt-5.5', 'gpt-5.5-mini', 'gpt-5.5-pro'] },
    },
    curve5h: { from: 0.27, to: 0.36 },
    curve24h: { from: 0.2, to: 0.26 },
    latency: [520, 8],
    failRate: 0.012,
  },
  {
    account: {
      id: 'acc_ollama_local',
      provider: 'openai-compatible',
      label: 'Ollama — workstation',
      enabled: true,
      priority: 50,
      weight: 1,
      limits: {},
      config: { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen3:32b', 'llama4:scout'] },
    },
    curve5h: { from: 0, to: 0 },
    curve24h: { from: 0, to: 0 },
    latency: [380, 22],
    failRate: 0.01,
  },
  {
    account: {
      id: 'acc_gemini_web',
      provider: 'gemini-web',
      label: 'Gemini web — experimental',
      enabled: false,
      status: 'disabled',
      priority: 90,
      weight: 1,
      limits: limits({ requestsDaily: 100 }),
      config: { profile: '~/.davecode/profiles/acc_gemini_web' },
    },
    curve5h: { from: 0, to: 0 },
    curve24h: { from: 0, to: 0 },
    latency: [2400, 14],
    failRate: 0.05,
  },
];

export const MOCK_ROUTES: Route[] = [
  {
    name: 'auto',
    description: 'Subscription first, then API keys, then the local model.',
    targets: [
      { provider: 'claude-cli', model: 'claude-sonnet-5-5', accountId: 'acc_claude_pro' },
      { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      { provider: 'openai', model: 'gpt-5.5' },
      { provider: 'openai-compatible', model: 'qwen3:32b' },
    ],
  },
  {
    name: 'fast',
    description: 'Low-latency completions for autocomplete and quick edits.',
    targets: [
      { provider: 'openai', model: 'gpt-5.5-mini' },
      { provider: 'anthropic', model: 'claude-haiku-5' },
      { provider: 'openai-compatible', model: 'llama4:scout' },
    ],
  },
  {
    name: 'reasoning',
    description: 'Planning and hard debugging. Expensive; used by the runner for repairs.',
    targets: [
      { provider: 'anthropic', model: 'claude-opus-5-5' },
      { provider: 'openai', model: 'gpt-5.5-pro' },
    ],
  },
  {
    name: 'local',
    description: 'Never leaves the machine.',
    targets: [{ provider: 'openai-compatible', model: 'qwen3:32b', accountId: 'acc_ollama_local' }],
  },
];

/** Share of traffic per route (sums to 1). */
export const ROUTE_MIX: [string, number][] = [
  ['auto', 0.62],
  ['fast', 0.24],
  ['reasoning', 0.06],
  ['local', 0.08],
];

const iso = (minutesAgo: number, now: number) => new Date(now - minutesAgo * 60_000).toISOString();

export function mockTasks(now: number): TaskNode[] {
  return [
    {
      id: 'foundation',
      title: 'Monorepo foundation, shared contracts and OSS docs',
      status: 'SUCCESS',
      dependsOn: [],
      priority: 100,
      attempts: 1,
      branch: 'davecode/task-foundation',
      acceptance: [
        'pnpm lint, typecheck, test and build pass',
        'Contracts documented in docs/API.md',
      ],
      updatedAt: iso(60 * 26, now),
    },
    {
      id: 'p1-storage',
      title: 'SQLite storage (WAL), migrations and repositories',
      description:
        'accounts, secrets, sessions, token_usage and audit_logs tables with typed repositories.',
      status: 'SUCCESS',
      dependsOn: ['foundation'],
      priority: 90,
      attempts: 1,
      branch: 'davecode/task-p1-storage',
      acceptance: [
        'Migrations are idempotent',
        'WAL mode enabled',
        'Repositories covered by tests',
      ],
      updatedAt: iso(60 * 20, now),
    },
    {
      id: 'p1-config',
      title: 'Layered config loader (defaults, global, project, env)',
      status: 'SUCCESS',
      dependsOn: ['foundation'],
      priority: 90,
      attempts: 2,
      branch: 'davecode/task-p1-config',
      acceptance: ['Later layers win', 'Invalid config reports the zod path'],
      notes: 'First attempt merged env vars before the project file; fixed in repair cycle 1.',
      updatedAt: iso(60 * 19, now),
    },
    {
      id: 'p1-identity',
      title: 'Encrypted keyring, sandbox manager and Chromium profile manager',
      status: 'SUCCESS',
      dependsOn: ['p1-storage'],
      priority: 90,
      attempts: 1,
      branch: 'davecode/task-p1-identity',
      acceptance: [
        'Secrets are AES-256-GCM encrypted at rest',
        'master.key created with 0600 permissions',
        'Each CLI account gets its own CLAUDE_CONFIG_DIR / CODEX_HOME',
      ],
      updatedAt: iso(60 * 14, now),
    },
    {
      id: 'p2-quota',
      title: 'Sliding-window quota engine (1m, 5h, 24h) and SQLite-backed tracker',
      status: 'SUCCESS',
      dependsOn: ['p1-storage'],
      priority: 80,
      attempts: 1,
      branch: 'davecode/task-p2-quota',
      acceptance: [
        'Windows slide, never reset on the hour',
        'Utilization = max(tokens, requests) ratio',
      ],
      updatedAt: iso(60 * 9, now),
    },
    {
      id: 'p2-providers',
      title: 'Provider adapters: anthropic, openai, gemini, openai-compatible, claude-cli',
      status: 'SUCCESS',
      dependsOn: ['p1-identity'],
      priority: 80,
      attempts: 2,
      branch: 'davecode/task-p2-providers',
      acceptance: [
        'Upstream errors mapped to ProviderError kinds',
        'Streaming and non-streaming paths',
      ],
      updatedAt: iso(60 * 6, now),
    },
    {
      id: 'p2-codex-cli',
      title: 'Codex CLI adapter isolated via CODEX_HOME',
      status: 'FAILED',
      dependsOn: ['p2-providers'],
      priority: 70,
      attempts: 3,
      branch: 'davecode/task-p2-codex-cli',
      acceptance: [
        'codex exec runs inside the account sandbox',
        'Usage parsed from the JSON event stream',
      ],
      notes:
        'Failed after 3 repair cycles: `codex exec --json` exits 2 under a fresh CODEX_HOME on Windows (no login prompt in non-TTY mode). Needs a human decision on the auth flow.',
      updatedAt: iso(60 * 4, now),
    },
    {
      id: 'p3-brain',
      title: 'Global and project brain managers, task graph DAG resolver with cycle detection',
      status: 'SUCCESS',
      dependsOn: ['foundation'],
      priority: 70,
      attempts: 1,
      branch: 'davecode/task-p3-brain',
      acceptance: ['Unknown dependencies rejected', 'Cycles rejected with the offending path'],
      updatedAt: iso(60 * 8, now),
    },
    {
      id: 'p2-router',
      title: 'Router with balancing, backpressure, cooldowns and hot failover',
      description:
        'Score candidates by priority, then weight × headroom. Smooth backpressure above 85 %, shift above 90 % of the 5 h quota, fail over before the first byte.',
      status: 'IN_PROGRESS',
      dependsOn: ['p2-quota', 'p2-providers', 'p1-config'],
      priority: 80,
      attempts: 2,
      branch: 'davecode/task-p2-router',
      acceptance: [
        'Never routes to an account in cooldown',
        'Weight is smoothly reduced above backpressureThreshold',
        'Failover honours Retry-After and routing.maxFailovers',
        'Emits router.failover for every hop',
      ],
      notes:
        'Repair cycle 1: two vitest assertions failed on Retry-After parsing (HTTP-date form).',
      updatedAt: iso(3, now),
    },
    {
      id: 'p1-gateway',
      title: 'Fastify gateway: /v1 OpenAI-compatible proxy, /api REST, SSE events',
      status: 'PENDING',
      dependsOn: ['p2-router'],
      priority: 75,
      acceptance: [
        'Implements docs/API.md exactly',
        'SSE heartbeat every 15 s',
        'Serves packages/ui/dist',
      ],
    },
    {
      id: 'p4-runner',
      title: 'Autonomous runner: state machine, validator, repair cycles, git flow',
      status: 'PENDING',
      dependsOn: ['p2-router', 'p3-brain'],
      priority: 60,
      acceptance: ['At most 3 repair cycles', 'Only merges after lint, typecheck and tests pass'],
    },
    {
      id: 'p5-cli',
      title: 'CLI commands and Ink TUI',
      status: 'PENDING',
      dependsOn: ['p1-gateway', 'p4-runner'],
      priority: 40,
      acceptance: [
        'davecode start | status | add-account | run',
        'TUI mirrors the dashboard overview',
      ],
    },
    {
      id: 'release-0.1.0',
      title: 'Integration tests, docs polish and v0.1.0 release',
      status: 'PENDING',
      dependsOn: ['p5-cli', 'p2-codex-cli'],
      priority: 10,
      acceptance: [
        'End-to-end failover test against two fake upstreams',
        'npm publish dry-run passes',
      ],
    },
  ];
}

export function mockState(tasks: TaskNode[], now: number): string {
  const done = tasks.filter((t) => t.status === 'SUCCESS');
  const active = tasks.find((t) => t.status === 'IN_PROGRESS');
  const failed = tasks.filter((t) => t.status === 'FAILED');
  const date = new Date(now).toISOString().slice(0, 10);
  return `# DaveCode: project state

_Last updated: ${date} by the autonomous runner_

## Current focus

${active ? `**${active.id}**: ${active.title}. Branch \`${active.branch ?? `davecode/task-${active.id}`}\`.` : 'Idle: no unblocked tasks.'}

## Done

${done.map((t) => `- [x] \`${t.id}\` ${t.title}`).join('\n')}

## Blockers

${
  failed.length
    ? failed
        .map((t) => `- \`${t.id}\` failed after ${t.attempts ?? 3} attempts. ${t.notes ?? ''}`)
        .join('\n')
    : 'None.'
}

## Next up

1. \`p1-gateway\` once the router merges.
2. \`p4-runner\` (needs \`p2-router\` and \`p3-brain\`).
3. Decide the Codex CLI auth flow so \`release-0.1.0\` is unblocked.

## Decisions log

| Date | Decision |
| :--- | :------- |
| 2026-10-06 | Node ≥ 22.12 + pnpm monorepo; \`better-sqlite3\`; Fastify; Ink TUI + Vite/React dashboard |
| 2026-10-06 | ToS-sensitive features ship behind \`experimental.*\` flags, off by default |
| 2026-10-06 | Judge defaults to deterministic checks (free) |
`;
}

export const MOCK_ARCHITECTURE = `# DaveCode: architecture

DaveCode is a **local-first** engine with two jobs: an OpenAI-compatible **gateway** with
quota-aware routing and hot failover, and an **autonomous runner** that walks a task DAG.

## Packages

| Package | Responsibility |
| :------ | :------------- |
| \`@davecode/core\` | Contracts, storage, identity, quotas, providers, router, brain, runner |
| \`@davecode/server\` | Fastify gateway: \`/v1\`, \`/api\`, SSE, serves the dashboard |
| \`davecode\` | CLI and Ink TUI |
| \`@davecode/ui\` | This dashboard |

## Routing

1. Resolve candidates from the route, provider prefix or bare model.
2. Drop disabled, cooling-down or saturated accounts.
3. Score: priority, then weight × headroom. Backpressure above **85 %**, shift above **90 %**.
4. On \`rate_limit\`, \`unavailable\`, \`timeout\`… cool down and fail over before the first byte.
`;
