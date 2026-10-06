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
      /** Route the runner uses for implementation calls. */
      route: z.string().default('auto'),
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
           * `jev`: ask TypeSafe Jev (paid, via any OpenAI-compatible gateway) whether
           * acceptance criteria are met, with calibrated confidence.
           * `llm`: use one of your own routes as the judge.
           */
          kind: z.enum(['none', 'jev', 'llm']).default('none'),
          model: z.string().optional(),
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
