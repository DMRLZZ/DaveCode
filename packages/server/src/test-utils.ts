/** Shared fixtures for gateway tests (temp home, in-memory DB, fake providers). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEngine,
  type DaveConfigInput,
  type Engine,
  FakeProvider,
  PROVIDER_KINDS,
  type ProviderKind,
} from '@davecode/core';

export interface TestEngine {
  engine: Engine;
  home: string;
  fake(kind: ProviderKind): FakeProvider;
  cleanup(): void;
}

export function makeTestEngine(config?: DaveConfigInput): TestEngine {
  const home = mkdtempSync(join(tmpdir(), 'davecode-gateway-'));
  const fakes = new Map<ProviderKind, FakeProvider>();
  for (const kind of PROVIDER_KINDS) fakes.set(kind, new FakeProvider(kind, [`${kind}-model`]));
  const engine = createEngine({
    home,
    env: {},
    providers: fakes,
    databasePath: ':memory:',
    ...(config ? { config } : {}),
  });
  return {
    engine,
    home,
    fake: (kind) => fakes.get(kind)!,
    cleanup() {
      engine.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
