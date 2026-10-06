import type {
  ProviderErrorKind,
  ProviderKind,
  UsageBucket,
  UsageRecord,
  UsageStatus,
} from '../types';
import type { Database } from './database';

interface UsageRow {
  id: string;
  request_id: string;
  account_id: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  status: string;
  error_kind: string | null;
  ts: number;
}

function toRecord(row: UsageRow): UsageRecord {
  const record: UsageRecord = {
    id: row.id,
    requestId: row.request_id,
    accountId: row.account_id,
    provider: row.provider as ProviderKind,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    latencyMs: row.latency_ms,
    status: row.status as UsageStatus,
    ts: row.ts,
  };
  if (row.error_kind) record.errorKind = row.error_kind as ProviderErrorKind;
  return record;
}

export interface UsageTotals {
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

export interface TimeseriesOptions {
  /** Window start (epoch ms). Rounded down to a bucket boundary. */
  since: number;
  /** Window end (epoch ms, exclusive). */
  until: number;
  /** Bucket width in milliseconds. */
  bucketMs: number;
}

/** Persistent per-request token usage (`token_usage` table). */
export class UsageRepository {
  constructor(private readonly db: Database) {}

  insert(record: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO token_usage (id, request_id, account_id, provider, model, prompt_tokens,
           completion_tokens, latency_ms, status, error_kind, ts)
         VALUES (@id, @requestId, @accountId, @provider, @model, @promptTokens,
           @completionTokens, @latencyMs, @status, @errorKind, @ts)`,
      )
      .run({ ...record, errorKind: record.errorKind ?? null });
  }

  /** Token and request totals for one account since `sinceTs` (inclusive). */
  totalsSince(accountId: string, sinceTs: number): UsageTotals {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(prompt_tokens), 0) AS p, COALESCE(SUM(completion_tokens), 0) AS c,
           COUNT(*) AS n
         FROM token_usage WHERE account_id = ? AND ts >= ?`,
      )
      .get(accountId, sinceTs) as { p: number; c: number; n: number };
    return { tokens: row.p + row.c, promptTokens: row.p, completionTokens: row.c, requests: row.n };
  }

  /** Every record since `sinceTs` (inclusive), oldest first. */
  since(sinceTs: number): UsageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM token_usage WHERE ts >= ? ORDER BY ts ASC, rowid ASC')
      .all(sinceTs) as UsageRow[];
    return rows.map(toRecord);
  }

  /** Most recent records first. */
  recent(limit = 100): UsageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM token_usage ORDER BY ts DESC, rowid DESC LIMIT ?')
      .all(Math.max(0, Math.floor(limit))) as UsageRow[];
    return rows.map(toRecord);
  }

  /**
   * Zero-filled, bucket-aligned time series for `GET /api/usage/timeseries`, oldest first.
   * Tokens are prompt + completion.
   */
  timeseries({ since, until, bucketMs }: TimeseriesOptions): UsageBucket[] {
    const width = Math.max(1, Math.floor(bucketMs));
    const start = Math.floor(since / width) * width;
    const count = Math.max(0, Math.ceil((until - start) / width));
    const buckets: UsageBucket[] = Array.from({ length: count }, (_, i) => ({
      ts: start + i * width,
      tokens: 0,
      requests: 0,
      byAccount: {},
    }));
    const rows = this.db
      .prepare(
        `SELECT CAST((ts - @start) / @width AS INTEGER) AS b, account_id AS accountId,
           SUM(prompt_tokens + completion_tokens) AS tokens, COUNT(*) AS requests
         FROM token_usage WHERE ts >= @start AND ts < @until
         GROUP BY b, account_id`,
      )
      .all({ start, width, until }) as Array<{
      b: number;
      accountId: string;
      tokens: number;
      requests: number;
    }>;
    for (const row of rows) {
      const bucket = buckets[row.b];
      if (!bucket) continue;
      bucket.tokens += row.tokens;
      bucket.requests += row.requests;
      bucket.byAccount[row.accountId] = { tokens: row.tokens, requests: row.requests };
    }
    return buckets;
  }

  /** Delete records older than `beforeTs`. Returns the number removed. */
  prune(beforeTs: number): number {
    return this.db.prepare('DELETE FROM token_usage WHERE ts < ?').run(beforeTs).changes;
  }
}
