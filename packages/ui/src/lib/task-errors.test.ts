import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { writeErrorMessage } from './task-errors';

describe('writeErrorMessage', () => {
  it('explains the structured refusals', () => {
    expect(
      writeErrorMessage(new ApiError(400, 'cycle', 'x', { cycle: ['a', 'b', 'a'] })),
    ).toContain('a → b → a');
    expect(
      writeErrorMessage(new ApiError(409, 'has_dependents', 'x', { dependents: ['b', 'c'] })),
    ).toContain('b, c');
    expect(writeErrorMessage(new ApiError(501, 'brain_read_only', 'x'))).toMatch(/read-only/);
    expect(writeErrorMessage(new ApiError(409, 'no_brain', 'x'))).toMatch(/davecode init/);
    expect(writeErrorMessage(new ApiError(409, 'task_in_progress', 'x'))).toMatch(/Reopen/);
  });

  it('falls back to the server message', () => {
    expect(writeErrorMessage(new ApiError(400, 'unknown_dependency', 'depends on "ghost"'))).toBe(
      'depends on "ghost"',
    );
    expect(writeErrorMessage(new Error('boom'))).toBe('boom');
  });
});
