/** Number, time and duration formatting shared across screens. Locale-aware where it matters. */

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en');

/** 1284 → "1.3K", 12_900_000 → "12.9M". */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return compact.format(n);
}

/** 1284 → "1,284". */
export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return integer.format(Math.round(n));
}

/** 0.873 → "87%". Values above 1 are shown as-is (an overflowing window reads "104%"). */
export function formatPercent(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 950 → "950 ms", 2340 → "2.34 s". */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Seconds → "42s", "3m 05s", "2h 14m", "3d 4h". */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Remaining time as a countdown clock: 83 → "1:23". */
export function formatCountdown(totalSec: number): string {
  const s = Math.max(0, Math.ceil(totalSec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Epoch ms → "14:03:27". */
export function formatClock(ts: number, withMs = false): string {
  const d = new Date(ts);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${String(d.getMilliseconds()).padStart(3, '0')}` : base;
}

/** Epoch ms → "14:03". */
export function formatHM(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Epoch ms relative to `now`: "just now", "12s ago", "4m ago", "3h ago", or a date. */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.round((now - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "req_8f3a2c9e41" → "8f3a2c9e" for dense columns. */
export function shortId(id: string, len = 8): string {
  const bare = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  return bare.slice(0, len);
}
