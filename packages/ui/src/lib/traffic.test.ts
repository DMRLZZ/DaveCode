import { describe, expect, it } from 'vitest';
import {
  applyChainEvent,
  type ChainEvent,
  chainLatency,
  chainsFromRecords,
  chainTokens,
  type RequestChain,
} from './traffic';
import type { UsageRecord } from './types';

function run(events: ChainEvent[]): RequestChain {
  let chain: RequestChain | undefined;
  for (const e of events) chain = applyChainEvent(chain, e);
  if (!chain) throw new Error('no events');
  return chain;
}

describe('applyChainEvent', () => {
  it('builds a 429 → failover → success chain', () => {
    const chain = run([
      {
        type: 'request.started',
        requestId: 'r1',
        model: 'davecode/auto',
        accountId: 'a',
        provider: 'claude-cli',
        ts: 1000,
      },
      {
        type: 'request.failed',
        requestId: 'r1',
        accountId: 'a',
        provider: 'claude-cli',
        error: { kind: 'rate_limit', message: 'Too many requests', status: 429 },
        ts: 1300,
      },
      {
        type: 'router.failover',
        requestId: 'r1',
        fromAccountId: 'a',
        toAccountId: 'b',
        reason: 'rate_limit',
        ts: 1301,
      },
      {
        type: 'request.started',
        requestId: 'r1',
        model: 'davecode/auto',
        accountId: 'b',
        provider: 'anthropic',
        ts: 1302,
      },
      {
        type: 'request.completed',
        requestId: 'r1',
        model: 'davecode/auto',
        accountId: 'b',
        provider: 'anthropic',
        promptTokens: 1200,
        completionTokens: 300,
        latencyMs: 900,
        ts: 2202,
      },
    ]);
    expect(chain.outcome).toBe('success');
    expect(chain.failovers).toBe(1);
    expect(chain.attempts.map((a) => [a.accountId, a.outcome])).toEqual([
      ['a', 'failed'],
      ['b', 'success'],
    ]);
    expect(chain.attempts[0]?.errorStatus).toBe(429);
    expect(chainTokens(chain)).toEqual({ prompt: 1200, completion: 300 });
    expect(chainLatency(chain)).toBe(1202);
  });

  it('stays pending between a failover and the next attempt', () => {
    const chain = run([
      {
        type: 'request.started',
        requestId: 'r2',
        model: 'm',
        accountId: 'a',
        provider: 'openai',
        ts: 0,
      },
      {
        type: 'request.failed',
        requestId: 'r2',
        accountId: 'a',
        provider: 'openai',
        error: { kind: 'unavailable', message: 'upstream 503', status: 503 },
        ts: 10,
      },
      {
        type: 'router.failover',
        requestId: 'r2',
        fromAccountId: 'a',
        toAccountId: 'b',
        reason: 'unavailable',
        ts: 11,
      },
    ]);
    expect(chain.outcome).toBe('pending');
  });

  it('fails when the router runs out of candidates', () => {
    const chain = run([
      {
        type: 'request.started',
        requestId: 'r3',
        model: 'm',
        accountId: 'a',
        provider: 'openai',
        ts: 0,
      },
      {
        type: 'request.failed',
        requestId: 'r3',
        accountId: 'a',
        provider: 'openai',
        error: { kind: 'rate_limit', message: '429', status: 429 },
        ts: 10,
      },
      {
        type: 'router.failover',
        requestId: 'r3',
        fromAccountId: 'a',
        toAccountId: null,
        reason: 'rate_limit',
        ts: 11,
      },
    ]);
    expect(chain.outcome).toBe('failed');
    expect(chain.exhausted).toBe(true);
  });

  it('ignores a duplicated started event (replay after reconnect)', () => {
    const started: ChainEvent = {
      type: 'request.started',
      requestId: 'r4',
      model: 'm',
      accountId: 'a',
      provider: 'openai',
      ts: 0,
    };
    expect(run([started, started]).attempts).toHaveLength(1);
  });
});

describe('chainsFromRecords', () => {
  it('groups attempts by requestId, newest chain first', () => {
    const rec = (over: Partial<UsageRecord>): UsageRecord => ({
      id: Math.random().toString(36),
      requestId: 'x',
      accountId: 'a',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 200,
      status: 'success',
      ts: 1000,
      ...over,
    });
    const chains = chainsFromRecords([
      rec({ requestId: 'old', ts: 500 }),
      rec({
        requestId: 'x',
        accountId: 'a',
        status: 'rate_limited',
        promptTokens: 0,
        completionTokens: 0,
        ts: 1000,
      }),
      rec({ requestId: 'x', accountId: 'b', ts: 1500 }),
    ]);
    expect(chains.map((c) => c.requestId)).toEqual(['x', 'old']);
    const [x] = chains;
    expect(x?.failovers).toBe(1);
    expect(x?.outcome).toBe('success');
    expect(x?.attempts[0]?.errorKind).toBe('rate_limit');
  });
});
