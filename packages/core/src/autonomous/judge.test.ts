import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../config/schema';
import type { CompletionResult, Router } from '../router/router';
import { fakeCompletion } from '../router/testing';
import type { TaskNode } from '../types';
import {
  acceptanceOf,
  createJudge,
  extractJsonObject,
  JevJudge,
  JudgeError,
  LlmJudge,
  NoneJudge,
} from './judge';
import type { ValidationReport } from './validator';

const task: TaskNode = {
  id: 'greet',
  title: 'Add greet()',
  description: 'Export greet(name).',
  status: 'IN_PROGRESS',
  dependsOn: [],
  acceptance: ['greet("x") returns "hello x"', 'covered by a test'],
};
const validation: ValidationReport = {
  ok: true,
  steps: [],
  durationMs: 10,
  summary: 'Validation PASSED.\n- test: PASS (0.1s) `node test.cjs`',
};
const input = { task, diffStat: ' src/greet.ts | 3 +++', diff: '+export const greet', validation };

function jevFetch(noul: number, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const body =
      status === 200
        ? {
            answers: { acceptance_met: { type: 'noul', noul } },
            usage: { input_tokens: 812, output_tokens: 3, cost: 0.00003 },
          }
        : { error: { message: 'bad key sk-secret-value' } };
    return new Response(JSON.stringify(body), { status });
  });
}

describe('NoneJudge', () => {
  it('always passes', async () => {
    expect((await new NoneJudge().judge()).pass).toBe(true);
  });
});

describe('JevJudge', () => {
  it('posts the Decisions API request shape with the env key', async () => {
    const fetchMock = jevFetch(0.96);
    const judge = new JevJudge({
      threshold: 0.7,
      env: { OPENROUTER_API_KEY: 'sk-or-test' },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const verdict = await judge.judge(input);
    expect(verdict).toMatchObject({ kind: 'jev', pass: true, confidence: 0.96 });
    expect(verdict.usage).toEqual({ inputTokens: 812, outputTokens: 3, cost: 0.00003 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer sk-or-test' });
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.state).toMatchObject({
      task: 'Add greet()\n\nExport greet(name).',
      acceptance: task.acceptance,
      diff_stat: input.diffStat,
      validation: validation.summary,
    });
    expect(body.questions.acceptance_met).toMatchObject({
      type: 'noul',
      instructions: 'Does the change satisfy every acceptance criterion of the task?',
    });
    expect(Object.keys(body.questions.acceptance_met.criteria).sort()).toEqual(['false', 'true']);
  });

  it('applies the threshold and honours model/baseUrl overrides and JEV_API_KEY', async () => {
    const fetchMock = jevFetch(0.69);
    const judge = new JevJudge({
      threshold: 0.7,
      model: 'typesafe/jev-2',
      baseUrl: 'http://localhost:9999/api/',
      env: { JEV_API_KEY: 'jev-key' },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const verdict = await judge.judge(input);
    expect(verdict.pass).toBe(false);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:9999/api/decisions');
    expect(JSON.parse(init?.body as string).model).toBe('typesafe/jev-2');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer jev-key' });

    const exact = new JevJudge({
      threshold: 0.7,
      env: { JEV_API_KEY: 'k' },
      fetch: jevFetch(0.7) as unknown as typeof fetch,
    });
    expect((await exact.judge(input)).pass).toBe(true);
  });

  it('fails clearly without a key and never calls the network', async () => {
    const fetchMock = jevFetch(1);
    const judge = new JevJudge({
      threshold: 0.7,
      env: {},
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(judge.judge(input)).rejects.toMatchObject({ code: 'missing_key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps HTTP errors and malformed responses to JudgeError without leaking the key', async () => {
    const http = new JevJudge({
      threshold: 0.7,
      env: { OPENROUTER_API_KEY: 'sk-secret-value' },
      fetch: jevFetch(0, 401) as unknown as typeof fetch,
    });
    const err = await http.judge(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeError);
    expect((err as JudgeError).message).toContain('HTTP 401');
    expect((err as JudgeError).message).not.toContain('sk-secret-value');

    const malformed = new JevJudge({
      threshold: 0.7,
      env: { OPENROUTER_API_KEY: 'k' },
      fetch: (async () => new Response('{"answers":{}}')) as unknown as typeof fetch,
    });
    await expect(malformed.judge(input)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('LlmJudge', () => {
  function router(content: string) {
    const calls: string[] = [];
    const r: Pick<Router, 'complete'> = {
      async complete(req): Promise<CompletionResult> {
        calls.push(req.model);
        return {
          completion: fakeCompletion(req.model, content),
          meta: {
            requestId: 'r',
            accountId: 'a',
            provider: 'openai',
            model: req.model,
            failovers: 0,
          },
        };
      },
    };
    return { r, calls };
  }

  it('parses a strict JSON verdict and applies the threshold', async () => {
    const ok = router('```json\n{"pass": true, "confidence": 0.9, "reasons": ["all met"]}\n```');
    const verdict = await new LlmJudge({ router: ok.r, route: 'review', threshold: 0.7 }).judge(
      input,
    );
    expect(verdict).toMatchObject({ kind: 'llm', pass: true, confidence: 0.9 });
    expect(ok.calls).toEqual(['davecode/review']);

    const low = router('{"pass": true, "confidence": 0.5, "reasons": []}');
    const lowVerdict = await new LlmJudge({ router: low.r, route: 'x', threshold: 0.7 }).judge(
      input,
    );
    expect(lowVerdict.pass).toBe(false);
    expect(lowVerdict.reasons.join(' ')).toMatch(/below the threshold/);
  });

  it('rejects unparseable verdicts', async () => {
    const bad = router('looks good to me');
    await expect(
      new LlmJudge({ router: bad.r, route: 'x', threshold: 0.7 }).judge(input),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('helpers', () => {
  it('extracts JSON objects and falls back to the title for acceptance', () => {
    expect(extractJsonObject('Verdict: {"a": 1} thanks')).toEqual({ a: 1 });
    expect(() => extractJsonObject('nothing')).toThrow();
    expect(acceptanceOf({ ...task, acceptance: [] })).toEqual(['Add greet(): Export greet(name).']);
  });

  it('creates the configured judge', () => {
    const judge = configSchema.parse({}).runner.judge;
    expect(createJudge(judge).kind).toBe('none');
    expect(createJudge({ ...judge, kind: 'jev' }).kind).toBe('jev');
    expect(() => createJudge({ ...judge, kind: 'llm' })).toThrow(/router/);
    const r = { complete: vi.fn() } as unknown as Pick<Router, 'complete'>;
    expect(createJudge({ ...judge, kind: 'llm' }, { router: r }).kind).toBe('llm');
  });
});
