import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChromiumContext,
  ChromiumProfileManager,
  ChromiumUnavailableError,
  ExperimentalDisabledError,
} from './chromium';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'davecode-profiles-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const fakeContext: ChromiumContext = {
  close: async () => {},
  newPage: async () => ({}),
  pages: () => [],
};

describe('ChromiumProfileManager', () => {
  it('derives isolated profile dirs and rejects unsafe ids', () => {
    const manager = new ChromiumProfileManager({ root, experimentalEnabled: false });
    expect(manager.profileDir('acc_1')).toBe(join(root, 'acc_1'));
    expect(() => manager.profileDir('../x')).toThrow();
    const dir = manager.ensure('acc_1');
    expect(existsSync(dir)).toBe(true);
    manager.remove('acc_1');
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses to launch when the experimental flag is off', async () => {
    const importPlaywright = vi.fn();
    const manager = new ChromiumProfileManager({
      root,
      experimentalEnabled: false,
      importPlaywright,
    });
    await expect(manager.launch('acc_1')).rejects.toBeInstanceOf(ExperimentalDisabledError);
    expect(importPlaywright).not.toHaveBeenCalled();
  });

  it('throws a clear error when playwright-core is missing', async () => {
    const manager = new ChromiumProfileManager({
      root,
      experimentalEnabled: true,
      importPlaywright: () => Promise.reject(new Error("Cannot find package 'playwright-core'")),
    });
    await expect(manager.launch('acc_1')).rejects.toThrow(ChromiumUnavailableError);
    await expect(manager.launch('acc_1')).rejects.toThrow(/pnpm add playwright-core/);
  });

  it('rejects a module without chromium.launchPersistentContext', async () => {
    const manager = new ChromiumProfileManager({
      root,
      experimentalEnabled: true,
      importPlaywright: async () => ({ chromium: {} }),
    });
    await expect(manager.launch('acc_1')).rejects.toThrow(ChromiumUnavailableError);
  });

  it('launches a persistent context in the account profile', async () => {
    const launchPersistentContext = vi.fn(async () => fakeContext);
    const manager = new ChromiumProfileManager({
      root,
      experimentalEnabled: true,
      importPlaywright: async () => ({ default: { chromium: { launchPersistentContext } } }),
    });
    const context = await manager.launch('acc_9', { headless: false, args: ['--lang=en'] });
    expect(context).toBe(fakeContext);
    expect(launchPersistentContext).toHaveBeenCalledWith(join(root, 'acc_9'), {
      headless: false,
      args: ['--lang=en'],
    });
    expect(existsSync(join(root, 'acc_9'))).toBe(true);
  });

  it('defaults to headless', async () => {
    const launchPersistentContext = vi.fn(async () => fakeContext);
    const manager = new ChromiumProfileManager({
      root,
      experimentalEnabled: true,
      importPlaywright: async () => ({ chromium: { launchPersistentContext } }),
    });
    await manager.launch('acc_1');
    expect(launchPersistentContext).toHaveBeenCalledWith(join(root, 'acc_1'), { headless: true });
  });
});
