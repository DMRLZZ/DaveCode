import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), which: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./proc', () => ({ which: mocks.which }));

import { openAppWindow } from './app-window';

beforeEach(() => {
  vi.clearAllMocks();
});

it.each([
  'https://public.example/',
  'file:///etc/passwd',
  'http://user:password@localhost:4040/',
  'http://localhost:4040/?token=private',
])('refuses unsafe app URLs before launching anything: %s', async (url) => {
  await expect(openAppWindow(url, {})).rejects.toThrow('loopback');
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('launches a loopback app window without a shell or credentials and handles a missing browser', async () => {
  mocks.which.mockReturnValueOnce('/browser/chrome');
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  expect(await openAppWindow('http://localhost:4040/', {})).toBe(true);
  expect(mocks.spawn).toHaveBeenCalledWith(
    '/browser/chrome',
    ['--app=http://localhost:4040/'],
    expect.objectContaining({ shell: false, windowsHide: true, stdio: 'ignore' }),
  );
  expect(child.unref).toHaveBeenCalled();
  mocks.which.mockReturnValue(undefined);
  expect(await openAppWindow('http://127.0.0.1:4040/', {})).toBe(false);
});
