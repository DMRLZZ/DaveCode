import { z } from 'zod';

const providerKind = z.enum([
  'anthropic',
  'openai',
  'gemini',
  'openai-compatible',
  'claude-cli',
  'codex-cli',
  'gemini-web',
]);

const routeTarget = z.object({
  provider: providerKind,
  model: z.string().min(1),
  accountId: z.string().optional(),
});

const route = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'route names are lowercase kebab-case'),
  description: z.string().optional(),
  targets: z.array(routeTarget).min(1),
});

/**
 * DaveCode configuration. Resolution order (later wins):
 * built-in defaults → ~/.davecode/config.json → <project>/.davecode/config.json → env vars.
 */
export const configSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(4040),
      /** Optional bearer token required on /v1 and /api. Strongly recommended if host != localhost. */
      authToken: z.string().optional(),
      /** Serve the built dashboard from the gateway. */
      dashboard: z.boolean().default(true),
    })
    .prefault({}),

  routing: z
    .object({
      /** Route used when a client asks for `davecode/auto` or an unknown alias. */
      defaultRoute: z.string().default('auto'),
      routes: z.array(route).default([]),
      /** Start smoothing traffic away from an account above this utilization (spec: 85%). */
      backpressureThreshold: z.number().min(0).max(1).default(0.85),
      /** Shift weight to alternate accounts above this 5h-quota utilization (spec: 90%). */
      quotaShiftThreshold: z.number().min(0).max(1).default(0.9),
      /** Upper bound on failover hops for a single request. */
      maxFailovers: z.number().int().min(0).default(4),
      /** Default cooldown applied after a 429/503 when the upstream sends no Retry-After. */
      cooldownMs: z.number().int().min(0).default(60_000),
    })
    .prefault({}),

  experimental: z
    .object({
      /**
       * Enables the `gemini-web` provider that automates a consumer Gemini web session
       * through Chromium. May violate Google's Terms of Service. Use at your own risk.
       */
      geminiWeb: z.boolean().default(false),
      /**
       * Allows balancing across several subscription accounts of the same provider
       * (e.g. multiple Claude Pro logins). May violate the provider's Terms of Service.
       */
      multiAccountRotation: z.boolean().default(false),
    })
    .prefault({}),

  runner: z
    .object({
      maxRepairCycles: z.number().int().min(0).max(10).default(3),
      branchPrefix: z.string().default('davecode/task-'),
      /** Branch that successful tasks are merged into. */
      baseBranch: z.string().default('main'),
      /**
       * Route (`auto` → `davecode/auto`) or model id (`openai/gpt-5`) the runner uses for
       * implementation calls with the built-in executor.
       */
      route: z.string().default('auto'),
      /**
       * `builtin`: DaveCode's own tool loop over the router (default).
       * `claude-cli`: delegate each task to the Claude Code CLI of a `claude-cli` account.
       */
      executor: z.enum(['builtin', 'claude-cli']).default('builtin'),
      /**
       * Push the task branch and open a pull request with `gh` instead of merging locally.
       * Falls back to a local merge (with a warning) when `gh` or a remote is unavailable.
       */
      pullRequests: z.boolean().default(false),
      /** Commit STATE.md / TASK_GRAPH.json changes on the base branch after every task. */
      commitBrain: z.boolean().default(true),
      /** Timeout for each validation command and each `run_command` tool call. */
      commandTimeoutMs: z.number().int().min(1_000).default(600_000),
      /** How long the continuous loop sleeps when no task is ready. */
      idlePollMs: z.number().int().min(100).default(30_000),
      /** Model round-trips allowed per implementation or repair pass (built-in executor). */
      maxIterations: z.number().int().min(1).max(500).default(40),
      /** Total prompt + completion tokens one task may consume across all passes. */
      maxTaskTokens: z.number().int().min(1_000).default(1_500_000),
      /**
       * Executables the `run_command` tool may start (bare names, no paths). `git` is always
       * restricted to read-only subcommands.
       */
      allowedCommands: z
        .array(z.string().regex(/^[A-Za-z0-9][\w.-]*$/, 'bare executable names only'))
        .default(['pnpm', 'npm', 'npx', 'node', 'git', 'tsc', 'biome', 'vitest']),
      claudeCli: z
        .object({
          /** `claude-cli` account whose sandbox is used; defaults to the first enabled one. */
          accountId: z.string().optional(),
          /** Model alias passed as `--model` (e.g. `sonnet`). */
          model: z.string().optional(),
          /** Claude Code tools pre-approved with `--allowedTools`. */
          allowedTools: z
            .array(z.string().min(1))
            .default([
              'Read',
              'Edit',
              'Write',
              'MultiEdit',
              'Glob',
              'Grep',
              'LS',
              'Bash(pnpm:*)',
              'Bash(npm:*)',
              'Bash(npx:*)',
              'Bash(node:*)',
              'Bash(git status:*)',
              'Bash(git diff:*)',
              'Bash(git log:*)',
            ]),
          /** Hard timeout for one CLI invocation. */
          timeoutMs: z.number().int().min(1_000).default(1_800_000),
        })
        .prefault({}),
      validate: z
        .object({
          lint: z.string().optional(),
          typecheck: z.string().optional(),
          test: z.string().optional(),
        })
        .prefault({}),
      judge: z
        .object({
          /**
           * `none`: deterministic checks only (free, default).
           * `jev`: ask TypeSafe Jev through the OpenRouter Decisions API (paid) whether the
           * acceptance criteria are met, with calibrated confidence. The API key is read from
           * the `OPENROUTER_API_KEY` or `JEV_API_KEY` environment variable, never from config.
           * `llm`: use one of your own routes as the judge.
           */
          kind: z.enum(['none', 'jev', 'llm']).default('none'),
          /** `jev`: model id (default `typesafe/jev-1.13`). `llm`: route or model id. */
          model: z.string().optional(),
          /** `jev`: Decisions API base URL (default `https://openrouter.ai/api/alpha`). */
          baseUrl: z.string().url().optional(),
          /** Minimum confidence (0..1) required for the judge to pass a task. */
          threshold: z.number().min(0).max(1).default(0.7),
        })
        .prefault({}),
    })
    .prefault({}),

  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type DaveConfig = z.infer<typeof configSchema>;
export type DaveConfigInput = z.input<typeof configSchema>;
