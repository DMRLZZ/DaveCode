import { describe, expect, it } from 'vitest';
import { configSchema } from './schema';

describe('configSchema', () => {
  it('fills safe defaults from an empty object', () => {
    const config = configSchema.parse({});
    expect(config.server).toMatchObject({ host: '127.0.0.1', port: 4040, dashboard: true });
    expect(config.routing.backpressureThreshold).toBe(0.85);
    expect(config.routing.quotaShiftThreshold).toBe(0.9);
    expect(config.runner.maxRepairCycles).toBe(3);
    expect(config.runner.judge.kind).toBe('none');
    expect(config.runner).toMatchObject({
      executor: 'builtin',
      pullRequests: false,
      commitBrain: true,
      maxIterations: 40,
    });
    expect(config.runner.allowedCommands).toContain('pnpm');
    expect(config.runner.claudeCli.allowedTools).toContain('Read');
  });

  it('rejects allowed commands that are paths', () => {
    const result = configSchema.safeParse({ runner: { allowedCommands: ['/bin/sh'] } });
    expect(result.success).toBe(false);
  });

  it('keeps ToS-sensitive features off by default', () => {
    const config = configSchema.parse({});
    expect(config.experimental.geminiWeb).toBe(false);
    expect(config.experimental.multiAccountRotation).toBe(false);
  });

  it('rejects invalid route names', () => {
    const result = configSchema.safeParse({
      routing: { routes: [{ name: 'Bad Name', targets: [{ provider: 'openai', model: 'x' }] }] },
    });
    expect(result.success).toBe(false);
  });
});
