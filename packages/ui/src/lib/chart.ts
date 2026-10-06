/** Small, dependency-free chart math (scales and tick generation). */

/** Round a step up to 1, 2, 2.5 or 5 × 10^n. */
function niceStep(rough: number): number {
  if (rough <= 0 || !Number.isFinite(rough)) return 1;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const f = rough / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * pow;
}

/** Clean y-axis ticks from 0 to at least `max`, about `count` of them. */
export function niceTicks(max: number, count = 4): number[] {
  const step = niceStep(Math.max(max, 1) / count);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

export function linearScale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Index of the point whose x is closest to `x` (points sorted by x). */
export function nearestIndex(xs: number[], x: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? 0) < x) lo = mid;
    else hi = mid;
  }
  return Math.abs((xs[lo] ?? 0) - x) <= Math.abs((xs[hi] ?? 0) - x) ? lo : hi;
}

/** SVG path through points; `close` returns an area path down to `baseline`. */
export function linePath(points: [number, number][], baseline?: number): string {
  if (points.length === 0) return '';
  const head = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join('');
  if (baseline === undefined) return head;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return head;
  return `${head}L${last[0].toFixed(1)},${baseline.toFixed(1)}L${first[0].toFixed(1)},${baseline.toFixed(1)}Z`;
}
