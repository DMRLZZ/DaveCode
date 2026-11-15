import { describe, expect, it } from 'vitest';
import {
  addPane,
  autoColumns,
  balance,
  dividers,
  EMPTY_LAYOUT,
  type Layout,
  layoutKeys,
  MIN_SHARE,
  movePane,
  neighbour,
  paneRects,
  removePane,
  resizeCells,
  resizeColumns,
  splitPane,
} from './layout';

const build = (count: number): Layout =>
  Array.from({ length: count }, (_, i) => i + 1).reduce(addPane, EMPTY_LAYOUT);

const shape = (layout: Layout) => layout.columns.map((column) => column.cells.map((c) => c.key));

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('autoColumns', () => {
  it('grows from one pane to a 2 × 2 and then 3 across', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(autoColumns)).toEqual([1, 2, 2, 2, 3, 3, 3]);
  });
});

describe('addPane', () => {
  it('fills the grid the way the fixed grid did', () => {
    expect(shape(build(1))).toEqual([[1]]);
    expect(shape(build(2))).toEqual([[1], [2]]);
    expect(shape(build(3))).toEqual([[1], [2, 3]]);
    expect(shape(build(4))).toEqual([
      [1, 4],
      [2, 3],
    ]);
    expect(shape(build(5))).toEqual([[1, 4], [2, 3], [5]]);
  });

  it('ignores a pane that is already placed', () => {
    const layout = build(2);
    expect(addPane(layout, 2)).toBe(layout);
  });

  it('gives a new column the average width, even after a resize', () => {
    const resized = resizeColumns(build(4), 0, 0.2);
    const next = addPane(resized, 5);
    const rects = paneRects(next);
    close(rects.get(5)?.width ?? 0, 1 / 3);
  });
});

describe('splitPane', () => {
  it('splits to the right without touching the other columns', () => {
    const layout = splitPane(build(2), 1, 3, 'right');
    expect(shape(layout)).toEqual([[1], [3], [2]]);
    const rects = paneRects(layout);
    close(rects.get(1)?.width ?? 0, 0.25);
    close(rects.get(3)?.width ?? 0, 0.25);
    close(rects.get(2)?.width ?? 0, 0.5);
  });

  it('splits down inside the column', () => {
    const layout = splitPane(build(2), 2, 3, 'down');
    expect(shape(layout)).toEqual([[1], [2, 3]]);
    const rects = paneRects(layout);
    close(rects.get(2)?.height ?? 0, 0.5);
    close(rects.get(3)?.top ?? 0, 0.5);
    close(rects.get(1)?.height ?? 0, 1);
  });

  it('falls back to the automatic place when the pane to split is gone', () => {
    expect(shape(splitPane(build(1), 99, 2, 'down'))).toEqual([[1], [2]]);
  });
});

describe('removePane', () => {
  it('drops an emptied column and lets the rest take the space', () => {
    const layout = removePane(build(2), 1);
    expect(shape(layout)).toEqual([[2]]);
    expect(paneRects(layout).get(2)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });

  it('returns the same layout for an unknown pane', () => {
    const layout = build(2);
    expect(removePane(layout, 7)).toBe(layout);
  });
});

describe('resizing', () => {
  it('moves a column border and keeps the total', () => {
    const rects = paneRects(resizeColumns(build(2), 0, 0.1));
    close(rects.get(1)?.width ?? 0, 0.6);
    close(rects.get(2)?.width ?? 0, 0.4);
  });

  it('never shrinks a column below the minimum share', () => {
    const rects = paneRects(resizeColumns(build(2), 0, 0.9));
    close(rects.get(2)?.width ?? 0, MIN_SHARE);
    const other = paneRects(resizeColumns(build(2), 0, -0.9));
    close(other.get(1)?.width ?? 0, MIN_SHARE);
  });

  it('moves a row border inside one column only', () => {
    const layout = resizeCells(build(3), 1, 0, -0.2);
    const rects = paneRects(layout);
    close(rects.get(2)?.height ?? 0, 0.3);
    close(rects.get(3)?.height ?? 0, 0.7);
    close(rects.get(1)?.height ?? 0, 1);
  });

  it('balance evens everything out', () => {
    const rects = paneRects(balance(resizeColumns(build(2), 0, 0.3)));
    close(rects.get(1)?.width ?? 0, 0.5);
  });
});

describe('movePane', () => {
  it('reorders inside a column', () => {
    expect(shape(movePane(build(3), 3, 'up'))).toEqual([[1], [3, 2]]);
    expect(movePane(build(3), 3, 'down')).toEqual(build(3));
  });

  it('moves a stacked pane into the neighbouring column', () => {
    expect(shape(movePane(build(3), 3, 'left'))).toEqual([[1, 3], [2]]);
  });

  it('gives a stacked pane its own column at the edge', () => {
    expect(shape(movePane(build(3), 3, 'right'))).toEqual([[1], [2], [3]]);
  });

  it('swaps a pane that is alone in its column with the next column', () => {
    expect(shape(movePane(build(3), 1, 'right'))).toEqual([[2, 3], [1]]);
    expect(movePane(build(3), 1, 'left')).toEqual(build(3));
  });
});

describe('geometry', () => {
  it('covers the whole area exactly once', () => {
    const rects = [...paneRects(build(5)).values()];
    close(
      rects.reduce((area, r) => area + r.width * r.height, 0),
      1,
    );
  });

  it('lists one border per gap', () => {
    const lines = dividers(build(4));
    expect(lines.map((l) => l.kind).sort()).toEqual(['column', 'row', 'row']);
    const column = lines.find((l) => l.kind === 'column');
    close(column?.left ?? 0, 0.5);
    expect(dividers(build(1))).toEqual([]);
  });

  it('picks the pane to focus when one closes', () => {
    const layout = build(4);
    expect(neighbour(layout, 1)).toBe(4);
    expect(neighbour(layout, 4)).toBe(1);
    expect(neighbour(build(2), 1)).toBe(2);
    expect(neighbour(build(1), 1)).toBeUndefined();
    expect(layoutKeys(layout)).toEqual([1, 4, 2, 3]);
  });
});
