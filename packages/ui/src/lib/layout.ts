/**
 * Pane layout of the terminal workspace: columns side by side, each a stack of panes. Sizes are
 * weights, so nothing has to add up to 100. Every function is pure and returns a new layout;
 * panes are identified by their key and never remount when the layout changes.
 */

export interface LayoutCell {
  key: number;
  weight: number;
}

export interface LayoutColumn {
  cells: LayoutCell[];
  weight: number;
}

export interface Layout {
  columns: LayoutColumn[];
}

/** A rectangle in fractions of the pane area (0 to 1). */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type SplitDirection = 'right' | 'down';

/** A draggable border: between column `column` and the next, or below cell `cell` of a column. */
export interface Divider extends Rect {
  kind: 'column' | 'row';
  column: number;
  /** Index of the cell above the border; only for `row`. */
  cell: number;
}

export const EMPTY_LAYOUT: Layout = { columns: [] };

/** Smallest share of the area a column or a pane may be dragged down to. */
export const MIN_SHARE = 0.12;

const sum = (weights: readonly { weight: number }[]) =>
  weights.reduce((total, item) => total + item.weight, 0);

/** Columns of the automatic arrangement: one pane fills the area, then 2 × 2, then 3 across. */
export function autoColumns(panes: number): number {
  if (panes <= 1) return 1;
  return panes <= 4 ? 2 : 3;
}

export function layoutKeys(layout: Layout): number[] {
  return layout.columns.flatMap((column) => column.cells.map((cell) => cell.key));
}

function locate(layout: Layout, key: number): { column: number; cell: number } | undefined {
  for (let column = 0; column < layout.columns.length; column++) {
    const cell = layout.columns[column]?.cells.findIndex((c) => c.key === key) ?? -1;
    if (cell !== -1) return { column, cell };
  }
  return undefined;
}

function averageWeight(items: readonly { weight: number }[]): number {
  return items.length === 0 ? 1 : sum(items) / items.length;
}

/** Places a new pane where the grid has room: a new column first, then the shortest column. */
export function addPane(layout: Layout, key: number): Layout {
  if (locate(layout, key)) return layout;
  const count = layoutKeys(layout).length + 1;
  if (layout.columns.length < autoColumns(count)) {
    const weight = averageWeight(layout.columns);
    return { columns: [...layout.columns, { weight, cells: [{ key, weight: 1 }] }] };
  }
  let target = 0;
  layout.columns.forEach((column, index) => {
    const best = layout.columns[target];
    if (best && column.cells.length <= best.cells.length) target = index;
  });
  return {
    columns: layout.columns.map((column, index) =>
      index === target
        ? {
            ...column,
            cells: [...column.cells, { key, weight: averageWeight(column.cells) }],
          }
        : column,
    ),
  };
}

/** Splits pane `near` in two, giving the new pane half of its space. */
export function splitPane(
  layout: Layout,
  near: number,
  key: number,
  direction: SplitDirection,
): Layout {
  const at = locate(layout, near);
  if (!at || locate(layout, key)) return addPane(layout, key);
  const columns = layout.columns.slice();
  const column = columns[at.column];
  if (!column) return layout;
  if (direction === 'right') {
    const half = column.weight / 2;
    columns.splice(
      at.column,
      1,
      { ...column, weight: half },
      {
        weight: half,
        cells: [{ key, weight: 1 }],
      },
    );
    return { columns };
  }
  const cells = column.cells.slice();
  const cell = cells[at.cell];
  if (!cell) return layout;
  const half = cell.weight / 2;
  cells.splice(at.cell, 1, { ...cell, weight: half }, { key, weight: half });
  columns[at.column] = { ...column, cells };
  return { columns };
}

/** Removes a pane; its neighbours take the space, and an emptied column disappears. */
export function removePane(layout: Layout, key: number): Layout {
  if (!locate(layout, key)) return layout;
  return {
    columns: layout.columns
      .map((column) => ({ ...column, cells: column.cells.filter((cell) => cell.key !== key) }))
      .filter((column) => column.cells.length > 0),
  };
}

/** Evens every column and every pane out again. */
export function balance(layout: Layout): Layout {
  return {
    columns: layout.columns.map((column) => ({
      weight: 1,
      cells: column.cells.map((cell) => ({ ...cell, weight: 1 })),
    })),
  };
}

/** Moves a pane one step left/right (into the neighbouring column) or up/down in its column. */
export function movePane(
  layout: Layout,
  key: number,
  direction: 'left' | 'right' | 'up' | 'down',
): Layout {
  const at = locate(layout, key);
  if (!at) return layout;
  const column = layout.columns[at.column];
  const cell = column?.cells[at.cell];
  if (!column || !cell) return layout;
  if (direction === 'up' || direction === 'down') {
    const to = at.cell + (direction === 'up' ? -1 : 1);
    if (to < 0 || to >= column.cells.length) return layout;
    const cells = column.cells.slice();
    cells.splice(at.cell, 1);
    cells.splice(to, 0, cell);
    return {
      columns: layout.columns.map((c, index) => (index === at.column ? { ...c, cells } : c)),
    };
  }
  const step = direction === 'left' ? -1 : 1;
  const alone = column.cells.length === 1;
  const to = at.column + step;
  // A pane alone in its column swaps places with the neighbouring column.
  if (alone) {
    if (to < 0 || to >= layout.columns.length) return layout;
    const columns = layout.columns.slice();
    const other = columns[to];
    if (!other) return layout;
    columns[to] = column;
    columns[at.column] = other;
    return { columns };
  }
  const without = layout.columns.map((c, index) =>
    index === at.column ? { ...c, cells: c.cells.filter((x) => x.key !== key) } : c,
  );
  // At the edge, a pane leaves its stack for a column of its own.
  if (to < 0 || to >= layout.columns.length) {
    const fresh: LayoutColumn = {
      weight: averageWeight(layout.columns),
      cells: [{ key, weight: 1 }],
    };
    return { columns: step < 0 ? [fresh, ...without] : [...without, fresh] };
  }
  return {
    columns: without.map((c, index) =>
      index === to ? { ...c, cells: [...c.cells, { key, weight: averageWeight(c.cells) }] } : c,
    ),
  };
}

/** Moves a share of `total` weight from one neighbour to the other, keeping both above the minimum. */
function shift<T extends { weight: number }>(
  items: readonly T[],
  index: number,
  share: number,
): T[] {
  const first = items[index];
  const second = items[index + 1];
  if (!first || !second) return items.slice();
  const total = sum(items);
  const min = total * MIN_SHARE;
  const pair = first.weight + second.weight;
  // Two neighbours smaller than twice the minimum cannot be resized at all.
  if (pair <= min * 2) return items.slice();
  const wanted = first.weight + share * total;
  const weight = Math.min(pair - min, Math.max(min, wanted));
  const next = items.slice();
  next[index] = { ...first, weight };
  next[index + 1] = { ...second, weight: pair - weight };
  return next;
}

/** Drags the border after column `index` by `share` of the area's width (negative: left). */
export function resizeColumns(layout: Layout, index: number, share: number): Layout {
  return { columns: shift(layout.columns, index, share) };
}

/** Drags the border below cell `index` of a column by `share` of the area's height. */
export function resizeCells(layout: Layout, column: number, index: number, share: number): Layout {
  return {
    columns: layout.columns.map((c, i) =>
      i === column ? { ...c, cells: shift(c.cells, index, share) } : c,
    ),
  };
}

/** Where each pane goes, in fractions of the pane area. */
export function paneRects(layout: Layout): Map<number, Rect> {
  const rects = new Map<number, Rect>();
  const width = sum(layout.columns);
  let left = 0;
  for (const column of layout.columns) {
    const columnWidth = width === 0 ? 0 : column.weight / width;
    const height = sum(column.cells);
    let top = 0;
    for (const cell of column.cells) {
      const cellHeight = height === 0 ? 0 : cell.weight / height;
      rects.set(cell.key, { left, top, width: columnWidth, height: cellHeight });
      top += cellHeight;
    }
    left += columnWidth;
  }
  return rects;
}

/** The borders that can be dragged, as zero-thickness lines in fractions of the pane area. */
export function dividers(layout: Layout): Divider[] {
  const lines: Divider[] = [];
  const width = sum(layout.columns);
  let left = 0;
  layout.columns.forEach((column, columnIndex) => {
    const columnWidth = width === 0 ? 0 : column.weight / width;
    const height = sum(column.cells);
    let top = 0;
    column.cells.forEach((cell, cellIndex) => {
      top += height === 0 ? 0 : cell.weight / height;
      if (cellIndex < column.cells.length - 1) {
        lines.push({
          kind: 'row',
          column: columnIndex,
          cell: cellIndex,
          left,
          top,
          width: columnWidth,
          height: 0,
        });
      }
    });
    left += columnWidth;
    if (columnIndex < layout.columns.length - 1) {
      lines.push({
        kind: 'column',
        column: columnIndex,
        cell: 0,
        left,
        top: 0,
        width: 0,
        height: 1,
      });
    }
  });
  return lines;
}

/** The pane to focus after `key` goes away: the one below or above it, then a neighbour column. */
export function neighbour(layout: Layout, key: number): number | undefined {
  const at = locate(layout, key);
  if (!at) return layoutKeys(layout)[0];
  const column = layout.columns[at.column];
  const inColumn = column?.cells[at.cell + 1] ?? column?.cells[at.cell - 1];
  if (inColumn) return inColumn.key;
  const beside = layout.columns[at.column + 1] ?? layout.columns[at.column - 1];
  return beside?.cells[0]?.key;
}
