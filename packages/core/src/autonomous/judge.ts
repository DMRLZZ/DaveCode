/**
 * Optional acceptance judge, run after the deterministic checks pass (`runner.judge`):
 * `none` (free, always passes), `jev` (TypeSafe Jev via the OpenRouter Decisions API, paid) or
 * `llm` (one of the user's own routes returning a strict JSON verdict).
 */
import { z } from 'zod';
import type { DaveConfig } from '../config/schema';
import type { Router } from '../router/router';
import type { TaskNode } from '../types';
import { routeModel } from './executor';
import { truncateHead } from './process';
import type { ValidationReport } from './validator';

export type JudgeKind = DaveConfig['runner']['judge']['kind'];
export type JudgeConfig = DaveConfig['runner']['judge'];

export interface JudgeInput {
  task: TaskNode;
  /** `git diff --stat` of the change. */
  diffStat: string;
  /** Full patch (truncated before it is sent). */
  diff?: string;
  validation: ValidationReport;
  signal?: AbortSignal;
}

export interface JudgeVerdict {
  kind: JudgeKind;
  pass: boolean;
  /** 0..1 when the judge reports one. */
  confidence?: number;
  reasons: string[];
  /** Upstream usage when reported (Jev: tokens and USD cost). */
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number };
}

export interface Judge {
  readonly kind: JudgeKind;
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}

/**
 * The judge could not reach a verdict (missing key, HTTP error, malformed response). The task
 * must not be merged.
 */
export class JudgeError extends Error {
  constructor(
    message: string,
    readonly code: 'missing_key' | 'http' | 'invalid_response' | 'network',
  ) {
    super(message);
    this.name = 'JudgeError';
  }
}

export const DEFAULT_JEV_BASE_URL = 'https://openrouter.ai/api/alpha';
export const DEFAULT_JEV_MODEL = 'typesafe/jev-1.13';
const MAX_DIFF_CHARS = 16_000;
const MAX_VALIDATION_CHARS = 6_000;

/** Acceptance criteria to judge; falls back to the title/description when none are listed. */
export function acceptanceOf(task: TaskNode): string[] {
  if (task.acceptance && task.acceptance.length > 0) return task.acceptance;
  return [task.description ? `${task.title}: ${task.description}` : task.title];
}

function taskText(task: TaskNode): string {
  return task.description ? `${task.title}\n\n${task.description}` : task.title;
}

/** `none`: deterministic checks only. */
export class NoneJudge implements Judge {
  readonly kind = 'none' as const;
  async judge(): Promise<JudgeVerdict> {
    return {
      kind: 'none',
      pass: true,
      reasons: ['deterministic checks only (runner.judge.kind = none)'],
    };
  }
}

// ---------------------------------------------------------------------------
// TypeSafe Jev (OpenRouter Decisions API)
// ---------------------------------------------------------------------------

const jevResponseSchema = z.object({
  answers: z.object({
    acceptance_met: z.object({
      type: z.literal('noul'),
      noul: z.number().min(0).max(1),
    }),
  }),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});

export interface JevJudgeOptions {
  threshold: number;
  model?: string;
  baseUrl?: string;
  /** Environment holding `OPENROUTER_API_KEY` or `JEV_API_KEY` (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Request timeout (default 60 s). */
  timeoutMs?: number;
}

export class JevJudge implements Judge {
  readonly kind = 'jev' as const;

  constructor(private readonly options: JevJudgeOptions) {}

  /** The request body sent to `POST {baseUrl}/decisions`. */
  buildRequest(input: JudgeInput): Record<string, unknown> {
    return {
      model: this.options.model ?? DEFAULT_JEV_MODEL,
      state: {
        task: taskText(input.task),
        acceptance: acceptanceOf(input.task),
        diff_stat: input.diffStat,
        validation: truncateHead(input.validation.summary, MAX_VALIDATION_CHARS),
        ...(input.diff ? { diff: truncateHead(input.diff, MAX_DIFF_CHARS) } : {}),
      },
      questions: {
        acceptance_met: {
          type: 'noul',
          instructions: 'Does the change satisfy every acceptance criterion of the task?',
          criteria: {
            true: 'Every acceptance criterion is demonstrably satisfied by the diff and the passing checks.',
            false:
              'At least one acceptance criterion is missing, only partially met, or cannot be verified from the evidence.',
          },
        },
      },
    };
  }

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    const env = this.options.env ?? process.env;
    const key = env.OPENROUTER_API_KEY?.trim() || env.JEV_API_KEY?.trim();
    if (!key) {
      throw new JudgeError(
        'runner.judge.kind is "jev" but neither OPENROUTER_API_KEY nor JEV_API_KEY is set',
        'missing_key',
      );
    }
    const base = (this.options.baseUrl ?? DEFAULT_JEV_BASE_URL).replace(/\/+$/, '');
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const doFetch = this.options.fetch ?? fetch;

    let res: Response;
    try {
      res = await doFetch(`${base}/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(this.buildRequest(input)),
        signal,
      });
    } catch (err) {
      throw new JudgeError(
        `Jev request failed: ${err instanceof Error ? err.message : String(err)}`,
        'network',
      );
    }
    const text = await res.text();
    if (!res.ok) {
      const detail = text.split(key).join('[redacted]').slice(0, 300);
      throw new JudgeError(`Jev returned HTTP ${res.status}: ${detail}`, 'http');
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new JudgeError('Jev returned a non-JSON response', 'invalid_response');
    }
    const parsed = jevResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new JudgeError('Jev response has no acceptance_met noul answer', 'invalid_response');
    }
    const noul = parsed.data.answers.acceptance_met.noul;
    const pass = noul >= this.options.threshold;
    const usage = parsed.data.usage;
    return {
      kind: 'jev',
      pass,
      confidence: noul,
      reasons: [`Jev acceptance_met = ${noul.toFixed(3)} (threshold ${this.options.threshold})`],
      ...(usage
        ? {
            usage: {
              ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
              ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
              ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
            },
          }
        : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// LLM judge over the user's own routes
// ---------------------------------------------------------------------------

export const llmVerdictSchema = z.object({
  pass: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});

export const LLM_JUDGE_PROMPT = `You are a strict code-review judge. Decide whether a change satisfies EVERY acceptance criterion of a task, using only the evidence provided (task, criteria, diff and the output of the deterministic checks, which already passed).

Respond with ONLY a JSON object, no prose and no code fences:
{"pass": boolean, "confidence": number between 0 and 1, "reasons": [short strings]}

Set "pass" to false if any criterion is unmet, partially met, or cannot be verified from the evidence.`;

/** Extracts the first JSON object from a model reply (tolerates code fences and prose). */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(candidate.slice(start, end + 1));
}

export interface LlmJudgeOptions {
  router: Pick<Router, 'complete'>;
  /** Route or model id (`runner.judge.model`, defaults to `runner.route`). */
  route: string;
  threshold: number;
}

export class LlmJudge implements Judge {
  readonly kind = 'llm' as const;

  constructor(private readonly options: LlmJudgeOptions) {}

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    const evidence = {
      task: taskText(input.task),
      acceptance: acceptanceOf(input.task),
      diff_stat: input.diffStat,
      diff: truncateHead(input.diff ?? '', MAX_DIFF_CHARS),
      validation: truncateHead(input.validation.summary, MAX_VALIDATION_CHARS),
    };
    let content: string;
    try {
      const { completion } = await this.options.router.complete(
        {
          model: routeModel(this.options.route),
          messages: [
            { role: 'system', content: LLM_JUDGE_PROMPT },
            { role: 'user', content: JSON.stringify(evidence, null, 2) },
          ],
          temperature: 0,
        },
        input.signal ? { signal: input.signal } : {},
      );
      const message = completion.choices[0]?.message.content;
      content = typeof message === 'string' ? message : '';
    } catch (err) {
      throw new JudgeError(
        `LLM judge call failed: ${err instanceof Error ? err.message : String(err)}`,
        'network',
      );
    }
    let verdict: z.infer<typeof llmVerdictSchema>;
    try {
      verdict = llmVerdictSchema.parse(extractJsonObject(content));
    } catch {
      throw new JudgeError(
        `LLM judge did not return a valid verdict: ${content.slice(0, 200)}`,
        'invalid_response',
      );
    }
    const pass = verdict.pass && verdict.confidence >= this.options.threshold;
    const reasons = [...verdict.reasons];
    if (verdict.pass && !pass) {
      reasons.push(
        `confidence ${verdict.confidence} is below the threshold ${this.options.threshold}`,
      );
    }
    return { kind: 'llm', pass, confidence: verdict.confidence, reasons };
  }
}

export interface CreateJudgeDeps {
  router?: Pick<Router, 'complete'>;
  /** Fallback route for the `llm` judge when `judge.model` is unset. */
  defaultRoute?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

/** Builds the judge selected by `runner.judge`. */
export function createJudge(config: JudgeConfig, deps: CreateJudgeDeps = {}): Judge {
  switch (config.kind) {
    case 'none':
      return new NoneJudge();
    case 'jev':
      return new JevJudge({
        threshold: config.threshold,
        ...(config.model ? { model: config.model } : {}),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(deps.env ? { env: deps.env } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    case 'llm': {
      if (!deps.router) throw new Error('the llm judge needs a router');
      return new LlmJudge({
        router: deps.router,
        route: config.model ?? deps.defaultRoute ?? 'auto',
        threshold: config.threshold,
      });
    }
  }
}
