import { describe, expect, it } from 'vitest';
import { gridColumns } from './desktop';

describe('gridColumns', () => {
  it('grows from one pane to a 2 × 2 and then 3 across', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(gridColumns)).toEqual([1, 2, 2, 2, 3, 3, 3]);
  });
});
