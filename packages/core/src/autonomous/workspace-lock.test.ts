import { describe, expect, it } from 'vitest';
import { WorkspaceLock } from './workspace-lock';

describe('WorkspaceLock', () => {
  it('is exclusive across owners and re-entrant per owner', () => {
    const lock = new WorkspaceLock();
    expect(lock.acquire('goal')).toBe(true);
    expect(lock.acquire('goal')).toBe(true);
    expect(lock.acquire('runner')).toBe(false);
    lock.release('runner');
    expect(lock.holder).toBe('goal');
    lock.release('goal');
    expect(lock.holder).toBe('goal');
    lock.release('goal');
    expect(lock.holder).toBeUndefined();
    expect(lock.acquire('runner')).toBe(true);
  });
});
