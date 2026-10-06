import { type KeyboardEvent, type PointerEvent, useId, useMemo, useState } from 'react';
import { linearScale, linePath, nearestIndex, niceTicks } from '../../lib/chart';
import { cn } from '../../lib/cn';
import { formatCompact, formatHM, formatInt } from '../../lib/format';
import { useElementWidth } from '../../lib/hooks';

export interface AreaPoint {
  ts: number;
  value: number;
  /** Extra readout shown in the tooltip (e.g. requests in that minute). */
  secondary?: number;
}

const M = { top: 14, right: 64, bottom: 24, left: 44 };

/**
 * Single-series area chart over time: 2px line, ~10% wash, hairline grid, crosshair with a
 * tooltip on hover and keyboard focus (arrow keys), and a direct label at the live end.
 */
export function AreaChart({
  points,
  height = 220,
  label,
  unit,
  secondaryLabel,
  liveTail,
  className,
}: {
  points: AreaPoint[];
  height?: number;
  /** Accessible name, e.g. "Token burn, last 60 minutes". */
  label: string;
  unit: string;
  secondaryLabel?: string;
  /** Treat the last point as an in-progress bucket (drawn lighter, labelled "now"). */
  liveTail?: boolean;
  className?: string;
}) {
  const [ref, width] = useElementWidth<HTMLElement>();
  const [active, setActive] = useState<number | null>(null);
  const clipId = useId();

  const geo = useMemo(() => {
    if (width <= 0 || points.length < 2) return null;
    const innerW = Math.max(10, width - M.left - M.right);
    const innerH = height - M.top - M.bottom;
    const max = Math.max(...points.map((p) => p.value), 1);
    const ticks = niceTicks(max, 4);
    const top = ticks[ticks.length - 1] ?? max;
    const first = points[0]?.ts ?? 0;
    const last = points[points.length - 1]?.ts ?? 1;
    const x = linearScale([first, last], [M.left, M.left + innerW]);
    const y = linearScale([0, top], [M.top + innerH, M.top]);
    const xy = points.map((p) => [x(p.ts), y(p.value)] as [number, number]);
    const quarter = 15 * 60_000;
    const xTicks: number[] = [];
    for (let t = Math.ceil(first / quarter) * quarter; t <= last; t += quarter) xTicks.push(t);
    return { innerW, innerH, ticks, x, y, xy, xTicks, baseline: M.top + innerH };
  }, [points, width, height]);

  const solid = geo ? (liveTail ? geo.xy.slice(0, -1) : geo.xy) : [];
  const tail = geo && liveTail ? geo.xy.slice(-2) : [];
  const end = geo?.xy[geo.xy.length - 1];
  const endPoint = points[points.length - 1];

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    if (!geo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left + M.left;
    setActive(
      nearestIndex(
        geo.xy.map((p) => p[0]),
        px,
      ),
    );
  };

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (points.length === 0) return;
    const lastIdx = points.length - 1;
    const cur = active ?? lastIdx;
    let next: number | null = cur;
    if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight') next = Math.min(lastIdx, cur + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = lastIdx;
    else if (e.key === 'Escape') next = null;
    else return;
    e.preventDefault();
    setActive(next);
  };

  const activePoint = active !== null ? points[active] : undefined;
  const activeXY = active !== null ? geo?.xy[active] : undefined;
  const max = points.reduce((m, p) => Math.max(m, p.value), 0);

  return (
    <figure
      ref={ref}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart is keyboard-explorable with arrow keys
      tabIndex={0}
      aria-label={`${label}. Peak ${formatInt(max)} ${unit}. Use the left and right arrow keys to read values.`}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
      className={cn('relative m-0 w-full select-none rounded-md', className)}
      style={{ height }}
    >
      {geo && (
        <svg width={width} height={height} className="block overflow-visible" aria-hidden>
          <defs>
            <clipPath id={clipId}>
              <rect x={M.left} y={0} width={geo.innerW} height={height} />
            </clipPath>
          </defs>

          {geo.ticks.map((t) => (
            <g key={t}>
              <line
                x1={M.left}
                x2={M.left + geo.innerW}
                y1={geo.y(t)}
                y2={geo.y(t)}
                className={t === 0 ? 'stroke-line-strong' : 'stroke-line'}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={M.left - 8}
                y={geo.y(t)}
                dy="0.32em"
                textAnchor="end"
                className="tnum fill-muted font-mono text-[10px]"
              >
                {formatCompact(t)}
              </text>
            </g>
          ))}

          {geo.xTicks.map((t) => (
            <text
              key={t}
              x={geo.x(t)}
              y={height - 6}
              textAnchor="middle"
              className="tnum fill-muted font-mono text-[10px]"
            >
              {formatHM(t)}
            </text>
          ))}

          <g clipPath={`url(#${clipId})`}>
            <path d={linePath(geo.xy, geo.baseline)} className="fill-accent" opacity={0.1} />
            <path
              d={linePath(solid)}
              fill="none"
              className="stroke-accent"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {tail.length === 2 && (
              <path
                d={linePath(tail)}
                fill="none"
                className="stroke-accent"
                strokeWidth={2}
                strokeDasharray="3 3"
                strokeLinecap="round"
                opacity={0.7}
              />
            )}
          </g>

          {end && endPoint && (
            <g>
              <circle
                cx={end[0]}
                cy={end[1]}
                r={4}
                className="fill-accent stroke-panel"
                strokeWidth={2}
              />
              <text
                x={end[0] + 9}
                y={end[1]}
                dy="-0.1em"
                className="tnum fill-fg font-mono text-[11px] font-medium"
              >
                {formatCompact(endPoint.value)}
              </text>
              <text x={end[0] + 9} y={end[1]} dy="1.15em" className="fill-muted text-[10px]">
                {liveTail ? 'now' : unit}
              </text>
            </g>
          )}

          {activeXY && (
            <g>
              <line
                x1={activeXY[0]}
                x2={activeXY[0]}
                y1={M.top}
                y2={geo.baseline}
                className="stroke-fg-2"
                strokeWidth={1}
                opacity={0.5}
                shapeRendering="crispEdges"
              />
              <circle
                cx={activeXY[0]}
                cy={activeXY[1]}
                r={4}
                className="fill-accent stroke-panel"
                strokeWidth={2}
              />
            </g>
          )}

          <rect
            x={M.left}
            y={M.top}
            width={geo.innerW}
            height={geo.innerH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
      )}

      {activePoint && activeXY && geo && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-32 rounded-md border border-line-strong bg-panel px-2.5 py-2 shadow-overlay"
          style={{
            left: Math.min(Math.max(activeXY[0] + 10, 0), width - 150),
          }}
        >
          <p className="tnum font-mono text-[11px] text-muted">
            {formatHM(activePoint.ts)}
            {liveTail && active === points.length - 1 && ' · in progress'}
          </p>
          <p className="mt-1 flex items-center gap-2">
            <span aria-hidden className="h-0.5 w-3 rounded-full bg-accent" />
            <span className="tnum text-[13px] font-semibold text-fg">
              {formatInt(activePoint.value)}
            </span>
            <span className="text-[11px] text-muted">{unit}</span>
          </p>
          {activePoint.secondary !== undefined && secondaryLabel && (
            <p className="mt-0.5 pl-5 text-[11px] text-fg-2">
              <span className="tnum font-mono">{formatInt(activePoint.secondary)}</span>{' '}
              {secondaryLabel}
            </p>
          )}
        </div>
      )}
    </figure>
  );
}

/** Minimal trend line for stat tiles (no axes; last point marked). */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) return <div style={{ width, height }} className={className} />;
  const max = Math.max(...values, 1);
  const x = linearScale([0, values.length - 1], [2, width - 4]);
  const y = linearScale([0, max], [height - 3, 3]);
  const pts = values.map((v, i) => [x(i), y(v)] as [number, number]);
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} aria-hidden className={cn('overflow-visible', className)}>
      <path d={linePath(pts, height - 1)} className="fill-fg-2" opacity={0.06} />
      <path
        d={linePath(pts)}
        fill="none"
        className="stroke-fg-2"
        strokeWidth={1.5}
        strokeLinejoin="round"
        opacity={0.7}
      />
      {last && <circle cx={last[0]} cy={last[1]} r={2.5} className="fill-accent" />}
    </svg>
  );
}
