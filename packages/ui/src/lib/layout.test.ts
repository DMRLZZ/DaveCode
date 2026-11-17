import { describe, expect, it } from 'vitest';
import {
  addPane,
  autoColumns,
  balance,
  dividers,
  EMPTY_LAYOUT,
  type Layout,
  layoutKeys,
  layoutShape,
  MIN_SHARE,
  neighbour,
  paneRects,
  removePane,
  resizeAt,
  splitPane,
} from './layout';

const build = (count: number): Layout =>
  Array.from({ length: count }, (_, i) => i + 1).reduce(addPane, EMPTY_LAYOUT);

const close = (a: number | undefined, b: number) => expect(a).toBeCloseTo(b, 6);

describe('autoColumns', () => {
  it('grows from one pane to a 2 × 2 and then 3 across', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(autoColumns)).toEqual([1, 2, 2, 2, 3, 3, 3]);
  });
});

describe('addPane', () => {
  it('fills the grid: side by side, then stacked, then a third column', () => {
    expect(layoutShape(EMPTY_LAYOUT)).toBe('');
    expect(layoutShape(build(1))).toBe('1');
    expect(layoutShape(build(2))).toBe('[1|2]');
    expect(layoutShape(build(3))).toBe('[1|[2/3]]');
    expect(layoutShape(build(4))).toBe('[[1/4]|[2/3]]');
    expect(layoutShape(build(5))).toBe('[[1/4]|[2/3]|5]');
    expect(layoutShape(build(6))).toBe('[[1/4]|[2/3]|[5/6]]');
  });

  it('ignores a pane that is already placed', () => {
    const layout = build(2);
    expect(addPane(layout, 2)).toBe(layout);
  });

  it('gives a new column the average width, even after a resize', () => {
    const resized = resizeAt(build(4), [], 0, 0.2);
    close(paneRects(addPane(resized, 5)).get(5)?.width, 1 / 3);
  });

  it('finds room after manual splits too', () => {
    const layout = addPane(splitPane(splitPane(build(2), 1, 3, 'down'), 2, 4, 'right'), 5);
    // Four panes in three columns: the fifth stacks into the last short column, not a fourth.
    expect(layoutShape(layout)).toBe('[[1/3]|2|[4/5]]');
    expect(layoutShape(addPane(layout, 6))).toBe('[[1/3]|[2/6]|[4/5]]');
  });
});

describe('splitPane', () => {
  it('splits to the right without touching the other panes', () => {
    const layout = splitPane(build(2), 1, 3, 'right');
    expect(layoutShape(layout)).toBe('[1|3|2]');
    const rects = paneRects(layout);
    close(rects.get(1)?.width, 0.25);
    close(rects.get(3)?.width, 0.25);
    close(rects.get(2)?.width, 0.5);
  });

  it('splits down inside its column', () => {
    const layout = splitPane(build(2), 2, 3, 'down');
    expect(layoutShape(layout)).toBe('[1|[2/3]]');
    const rects = paneRects(layout);
    close(rects.get(2)?.height, 0.5);
    close(rects.get(3)?.top, 0.5);
    close(rects.get(1)?.height, 1);
  });

  it('splits one stacked pane sideways and leaves the pane above it alone', () => {
    // 2 on top of 3; splitting 3 to the right must not narrow 2.
    const layout = splitPane(build(3), 3, 4, 'right');
    expect(layoutShape(layout)).toBe('[1|[2/[3|4]]]');
    const rects = paneRects(layout);
    close(rects.get(2)?.width, 0.5);
    close(rects.get(3)?.width, 0.25);
    close(rects.get(4)?.width, 0.25);
    close(rects.get(4)?.left, 0.75);
    close(rects.get(4)?.top, 0.5);
    close(rects.get(1)?.width, 0.5);
  });

  it('splits the only pane', () => {
    expect(layoutShape(splitPane(build(1), 1, 2, 'down'))).toBe('[1/2]');
    expect(layoutShape(splitPane(build(1), 1, 2, 'right'))).toBe('[1|2]');
  });

  it('falls back to the automatic place when the pane to split is gone', () => {
    expect(layoutShape(splitPane(build(1), 99, 2, 'down'))).toBe('[1|2]');
    expect(layoutShape(splitPane(EMPTY_LAYOUT, 1, 2, 'down'))).toBe('2');
  });
});

describe('removePane', () => {
  it('lets the neighbours take the space and collapses what is left', () => {
    const layout = removePane(build(2), 1);
    expect(layoutShape(layout)).toBe('2');
    expect(paneRects(layout).get(2)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
    expect(layoutShape(removePane(build(1), 1))).toBe('');
  });

  it('merges a split that ends up inside one of the same direction', () => {
    // [1|[2/[3|4]]] without 2 is three panes side by side, 3 and 4 sharing the old column.
    const layout = removePane(splitPane(build(3), 3, 4, 'right'), 2);
    expect(layoutShape(layout)).toBe('[1|3|4]');
    const rects = paneRects(layout);
    close(rects.get(1)?.width, 0.5);
    close(rects.get(3)?.width, 0.25);
    close(rects.get(4)?.width, 0.25);
  });

  it('returns the same layout for an unknown pane', () => {
    const layout = build(2);
    expect(removePane(layout, 7)).toBe(layout);
  });
});

describe('resizing', () => {
  it('moves a border and keeps the total', () => {
    const rects = paneRects(resizeAt(build(2), [], 0, 0.1));
    close(rects.get(1)?.width, 0.6);
    close(rects.get(2)?.width, 0.4);
  });

  it('never shrinks a side below the minimum share of the area', () => {
    close(paneRects(resizeAt(build(2), [], 0, 0.9)).get(2)?.width, MIN_SHARE);
    close(paneRects(resizeAt(build(2), [], 0, -0.9)).get(1)?.width, MIN_SHARE);
  });

  it('moves a border inside a nested split by the same distance on screen', () => {
    // [1|[2/3]]: the border between 2 and 3 belongs to the split at path [1].
    const layout = resizeAt(build(3), [1], 0, -0.2);
    const rects = paneRects(layout);
    close(rects.get(2)?.height, 0.3);
    close(rects.get(3)?.height, 0.7);
    close(rects.get(1)?.height, 1);
    // In [1|[2/[3|4]]] the 3|4 split spans half the width: 0.1 of the area is 0.1 on screen.
    const nested = resizeAt(splitPane(build(3), 3, 4, 'right'), [1, 1], 0, 0.1);
    close(paneRects(nested).get(3)?.width, 0.35);
    close(paneRects(nested).get(4)?.width, 0.15);
  });

  it('ignores a border that does not exist', () => {
    const layout = build(2);
    expect(paneRects(resizeAt(layout, [], 5, 0.1))).toEqual(paneRects(layout));
    expect(resizeAt(EMPTY_LAYOUT, [], 0, 0.1)).toBe(EMPTY_LAYOUT);
  });

  it('balance evens everything out', () => {
    close(paneRects(balance(resizeAt(build(2), [], 0, 0.3))).get(1)?.width, 0.5);
    expect(balance(EMPTY_LAYOUT)).toEqual(EMPTY_LAYOUT);
  });
});

describe('geometry', () => {
  it('covers the whole area exactly once', () => {
    for (const layout of [build(5), splitPane(build(3), 3, 4, 'right')]) {
      close(
        [...paneRects(layout).values()].reduce((area, r) => area + r.width * r.height, 0),
        1,
      );
    }
  });

  it('lists one border per gap, each with the split it belongs to', () => {
    const lines = dividers(build(4));
    expect(lines.map((l) => `${l.kind}@${l.path.join('.')}:${l.index}`).sort()).toEqual([
      'column@:0',
      'row@0:0',
      'row@1:0',
    ]);
    close(lines.find((l) => l.kind === 'column')?.left, 0.5);
    const right = lines.find((l) => l.kind === 'row' && l.path[0] === 1);
    close(right?.left, 0.5);
    close(right?.width, 0.5);
    close(right?.top, 0.5);
    expect(dividers(build(1))).toEqual([]);
  });

  it('picks the pane to focus when one closes', () => {
    const layout = build(4);
    expect(layoutKeys(layout)).toEqual([1, 4, 2, 3]);
    expect(neighbour(layout, 1)).toBe(4);
    expect(neighbour(layout, 3)).toBe(2);
    expect(neighbour(build(2), 1)).toBe(2);
    expect(neighbour(build(1), 1)).toBeUndefined();
    expect(neighbour(layout, 99)).toBe(1);
  });
});
