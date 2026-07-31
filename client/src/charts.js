/**
 * Chart palette + shared recharts config.
 *
 * The eight categorical hues are assigned in FIXED slot order and are never
 * cycled or re-ordered — a series keeps its colour when a filter changes the
 * series count, so the eye can follow one rep across views. The order below is
 * the validated one (worst adjacent CVD ΔE 9.1, normal-vision ΔE 19.6 on a
 * white surface). Three slots sit below 3:1 contrast on white, so every chart
 * in this app ships the equivalent table view next to it.
 *
 * Beyond eight series we fold the tail into "Other" rather than inventing hues.
 */

export const SERIES_COLORS = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
];

export const NEUTRAL = '#8c96a3';
export const GRID = '#e2e6ec';
export const AXIS_INK = '#6b7683';

/** Stable colour for slot `index`; anything past the palette is neutral grey. */
export function seriesColor(index) {
  return index < SERIES_COLORS.length ? SERIES_COLORS[index] : NEUTRAL;
}

/** '2026-07' → 'Jul 26' for a compact axis. */
export function monthLabel(month) {
  if (!month) return '';
  const [y, m] = String(month).split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  if (Number.isNaN(d.getTime())) return month;
  return `${d.toLocaleString('en-IN', { month: 'short' })} ${String(y).slice(2)}`;
}

/** Compact INR for axis ticks: 12.5L / 3.2Cr / 45k. */
export function inrAxis(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`;
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`;
  if (abs >= 1000) return `₹${Math.round(n / 1000)}k`;
  return `₹${Math.round(n)}`;
}

export const AXIS_PROPS = {
  stroke: GRID,
  tick: { fill: AXIS_INK, fontSize: 12 },
  tickLine: false,
  axisLine: { stroke: GRID },
};

export const TOOLTIP_STYLE = {
  contentStyle: {
    background: '#ffffff',
    border: '1px solid #e2e6ec',
    borderRadius: 8,
    boxShadow: '0 6px 20px rgba(20, 30, 45, 0.12)',
    fontSize: 13,
  },
  labelStyle: { color: '#1c2430', fontWeight: 600, marginBottom: 4 },
  cursor: { stroke: '#c8cfd8', strokeWidth: 1 },
};
