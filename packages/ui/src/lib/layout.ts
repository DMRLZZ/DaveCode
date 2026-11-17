/**
 * Pane layout of the terminal workspace: a tree of splits, like a tiling terminal. A `row`
 * split puts its children side by side, a `column` split stacks them, and any child can be
 * split again, so splitting one pane never resizes the panes next to it. Sizes are weights, so
 * nothing has to add up to 100. Every function is pure and returns a new layout; panes are
 * identified by their key and never remount when the layout changes.
 */

export type LayoutNode =
  | { kind: 'pane'; key: number }
  | { kind: 'split'; direction: 'row' | 'column'; children: LayoutChild[] };

export interface LayoutChild {
  node: LayoutNode;
  weight: number;
}

export interface Layout {
  root: LayoutNode | undefined;
}

/** A rectangle in fractions of the pane area (0 to 1). */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type SplitDirection = 'right' | 'down';

/** A draggable border between child `index` and the next one of the split found at `path`. */
export interface Divider extends Rect {
  /** `column`: a vertical line, dragged sideways. `row`: a horizontal line, dragged up or down. */
  kind: 'column' | 'row';
  /** Child indexes from the root down to the split that owns the border. */
  path: number[];
  index: number;
}

export const EMPTY_LAYOUT: Layout = { root: undefined };

/** Smallest share of the whole area a side of a border may be dragged down to. */
export const MIN_SHARE = 0.1;

const FULL: Rect = { left: 0, top: 0, width: 1, height: 1 };

const sum = (children: readonly LayoutChild[]) =>
  children.reduce((total, child) => total + child.weight, 0);

const pane = (key: number): LayoutNode => ({ kind: 'pane', key });

function average(children: readonly LayoutChild[]): number {
  return children.length === 0 ? 1 : sum(children) / children.length;
}

/** Columns of the automatic arrangement: one pane fills the area, then 2 × 2, then 3 across. */
export function autoColumns(panes: number): number {
  if (panes <= 1) return 1;
  return panes <= 4 ? 2 : 3;
}

function keysOf(node: LayoutNode | undefined): number[] {
  if (!node) return [];
  if (node.kind === 'pane') return [node.key];
  return node.children.flatMap((child) => keysOf(child.node));
}

/** Every pane on the grid, left to right and top to bottom. */
export function layoutKeys(layout: Layout): number[] {
  return keysOf(layout.root);
}

/**
 * Keeps the tree canonical: a split with one child is that child, and a split nested in a split
 * of the same direction is merged into it (its children share the space it had).
 */
function normalize(node: LayoutNode | undefined): LayoutNode | undefined {
  if (!node || node.kind === 'pane') return node;
  const children: LayoutChild[] = [];
  for (const child of node.children) {
    const inner = normalize(child.node);
    if (!inner) continue;
    if (inner.kind === 'split' && inner.direction === node.direction) {
      const total = sum(inner.children);
      for (const grandchild of inner.children) {
        children.push({
          node: grandchild.node,
          weight: total === 0 ? child.weight : (child.weight * grandchild.weight) / total,
        });
      }
    } else children.push({ node: inner, weight: child.weight });
  }
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0]?.node;
  return { kind: 'split', direction: node.direction, children };
}

/** Adds a pane under (below) whatever `node` is. */
function stackInto(node: LayoutNode, key: number): LayoutNode {
  if (node.kind === 'split' && node.direction === 'column') {
    return {
      ...node,
      children: [...node.children, { node: pane(key), weight: average(node.children) }],
    };
  }
  return {
    kind: 'split',
    direction: 'column',
    children: [
      { node, weight: 1 },
      { node: pane(key), weight: 1 },
    ],
  };
}

/** Places a new pane where the grid has room: a new column first, then the shortest column. */
export function addPane(layout: Layout, key: number): Layout {
  const { root } = layout;
  if (!root) return { root: pane(key) };
  if (keysOf(root).includes(key)) return layout;
  const columns: LayoutChild[] =
    root.kind === 'split' && root.direction === 'row' ? root.children : [{ node: root, weight: 1 }];
  if (columns.length < autoColumns(keysOf(root).length + 1)) {
    return {
      root: {
        kind: 'split',
        direction: 'row',
        children: [...columns, { node: pane(key), weight: average(columns) }],
      },
    };
  }
  let target = 0;
  columns.forEach((column, index) => {
    const best = columns[target];
    if (best && keysOf(column.node).length <= keysOf(best.node).length) target = index;
  });
  const children = columns.map((column, index) =>
    index === target ? { ...column, node: stackInto(column.node, key) } : column,
  );
  return { root: normalize({ kind: 'split', direction: 'row', children }) };
}

function splitNode(
  node: LayoutNode,
  near: number,
  key: number,
  direction: 'row' | 'column',
): LayoutNode {
  if (node.kind === 'pane') {
    if (node.key !== near) return node;
    return {
      kind: 'split',
      direction,
      children: [
        { node, weight: 1 },
        { node: pane(key), weight: 1 },
      ],
    };
  }
  const children: LayoutChild[] = [];
  for (const child of node.children) {
    const isNear = child.node.kind === 'pane' && child.node.key === near;
    if (isNear && node.direction === direction) {
      // Same direction as the split it sits in: the two halves become siblings.
      children.push(
        { node: child.node, weight: child.weight / 2 },
        { node: pane(key), weight: child.weight / 2 },
      );
    } else {
      children.push({ ...child, node: splitNode(child.node, near, key, direction) });
    }
  }
  return { ...node, children };
}

/** Splits pane `near` in two, giving the new pane half of its space and touching nothing else. */
export function splitPane(
  layout: Layout,
  near: number,
  key: number,
  direction: SplitDirection,
): Layout {
  const keys = layoutKeys(layout);
  if (!layout.root || !keys.includes(near) || keys.includes(key)) return addPane(layout, key);
  return { root: splitNode(layout.root, near, key, direction === 'right' ? 'row' : 'column') };
}

function without(node: LayoutNode, key: number): LayoutNode | undefined {
  if (node.kind === 'pane') return node.key === key ? undefined : node;
  const children: LayoutChild[] = [];
  for (const child of node.children) {
    const inner = without(child.node, key);
    if (inner) children.push({ ...child, node: inner });
  }
  return { ...node, children };
}

/** Removes a pane; its neighbours in the same split take the space. */
export function removePane(layout: Layout, key: number): Layout {
  if (!layout.root || !layoutKeys(layout).includes(key)) return layout;
  return { root: normalize(without(layout.root, key)) };
}

function even(node: LayoutNode): LayoutNode {
  if (node.kind === 'pane') return node;
  return {
    ...node,
    children: node.children.map((child) => ({ node: even(child.node), weight: 1 })),
  };
}

/** Evens every split out again. */
export function balance(layout: Layout): Layout {
  return { root: layout.root ? even(layout.root) : undefined };
}

/** Calls `visit` for every child of every split, with the rectangle the child gets. */
function walk(
  node: LayoutNode,
  rect: Rect,
  path: number[],
  visit: {
    pane?: (key: number, rect: Rect) => void;
    border?: (divider: Divider) => void;
  },
): void {
  if (node.kind === 'pane') {
    visit.pane?.(node.key, rect);
    return;
  }
  const total = sum(node.children);
  const row = node.direction === 'row';
  let offset = 0;
  node.children.forEach((child, index) => {
    const share = total === 0 ? 0 : child.weight / total;
    const childRect: Rect = row
      ? {
          left: rect.left + offset * rect.width,
          top: rect.top,
          width: share * rect.width,
          height: rect.height,
        }
      : {
          left: rect.left,
          top: rect.top + offset * rect.height,
          width: rect.width,
          height: share * rect.height,
        };
    walk(child.node, childRect, [...path, index], visit);
    offset += share;
    if (index < node.children.length - 1) {
      visit.border?.(
        row
          ? {
              kind: 'column',
              path,
              index,
              left: rect.left + offset * rect.width,
              top: rect.top,
              width: 0,
              height: rect.height,
            }
          : {
              kind: 'row',
              path,
              index,
              left: rect.left,
              top: rect.top + offset * rect.height,
              width: rect.width,
              height: 0,
            },
      );
    }
  });
}

/** Where each pane goes, in fractions of the pane area. */
export function paneRects(layout: Layout): Map<number, Rect> {
  const rects = new Map<number, Rect>();
  if (layout.root) walk(layout.root, FULL, [], { pane: (key, rect) => rects.set(key, rect) });
  return rects;
}

/** The borders that can be dragged, as zero-thickness lines in fractions of the pane area. */
export function dividers(layout: Layout): Divider[] {
  const lines: Divider[] = [];
  if (layout.root) walk(layout.root, FULL, [], { border: (divider) => lines.push(divider) });
  return lines;
}

/**
 * Drags the border after child `index` of the split at `path` by `share` of the whole area
 * (negative: left or up). Neither side goes below {@link MIN_SHARE} of the area.
 */
export function resizeAt(
  layout: Layout,
  path: readonly number[],
  index: number,
  share: number,
): Layout {
  if (!layout.root) return layout;
  const resize = (node: LayoutNode, depth: number, extent: Rect): LayoutNode => {
    if (node.kind === 'pane') return node;
    const total = sum(node.children);
    const row = node.direction === 'row';
    if (depth < path.length) {
      const step = path[depth];
      return {
        ...node,
        children: node.children.map((child, i) => {
          const part = total === 0 ? 0 : child.weight / total;
          const childExtent: Rect = row
            ? { ...extent, width: part * extent.width }
            : { ...extent, height: part * extent.height };
          return i === step
            ? { ...child, node: resize(child.node, depth + 1, childExtent) }
            : child;
        }),
      };
    }
    const first = node.children[index];
    const second = node.children[index + 1];
    // How much of the whole area this split spans along the direction being dragged.
    const span = row ? extent.width : extent.height;
    if (!first || !second || span === 0 || total === 0) return node;
    const perArea = total / span;
    const min = MIN_SHARE * perArea;
    const pair = first.weight + second.weight;
    // Two neighbours smaller than twice the minimum cannot be resized at all.
    if (pair <= min * 2) return node;
    const weight = Math.min(pair - min, Math.max(min, first.weight + share * perArea));
    const children = node.children.slice();
    children[index] = { ...first, weight };
    children[index + 1] = { ...second, weight: pair - weight };
    return { ...node, children };
  };
  return { root: resize(layout.root, 0, FULL) };
}

/** The pane to focus after `key` goes away: the next one in reading order, else the previous. */
export function neighbour(layout: Layout, key: number): number | undefined {
  const keys = layoutKeys(layout);
  const at = keys.indexOf(key);
  if (at === -1) return keys[0];
  return keys[at + 1] ?? keys[at - 1];
}

function shapeOf(node: LayoutNode): string {
  if (node.kind === 'pane') return String(node.key);
  const separator = node.direction === 'row' ? '|' : '/';
  return `[${node.children.map((child) => shapeOf(child.node)).join(separator)}]`;
}

/** The tree in one line, for logs and tests: `[1|[2/3]]` is pane 1 beside 2 stacked on 3. */
export function layoutShape(layout: Layout): string {
  return layout.root ? shapeOf(layout.root) : '';
}
