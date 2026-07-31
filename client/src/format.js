/** Shared display formatters (INR money, Indian date formats). */

const inrFull = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
});

const inrCompact = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

export function inr(value) {
  return inrFull.format(Number(value) || 0);
}

export function inr0(value) {
  return inrCompact.format(Number(value) || 0);
}

/** 'YYYY-MM-DD' → '31 Jul 2026' */
export function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Any timestamp → '31 Jul 2026, 14:05' */
export function fmtDateTime(value) {
  if (!value) return '—';
  const normalised = String(value).includes('T') ? String(value) : `${value}Z`.replace(' ', 'T');
  const d = new Date(normalised);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** '2026-07-31 09:12:00' (UTC, from the db) → '3 minutes ago' */
export function timeAgo(value) {
  if (!value) return 'never';
  const normalised = String(value).includes('T') ? String(value) : `${String(value).replace(' ', 'T')}Z`;
  const then = new Date(normalised).getTime();
  if (Number.isNaN(then)) return String(value);
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function num(value) {
  return new Intl.NumberFormat('en-IN').format(Number(value) || 0);
}

/** Build a query string, dropping empty values. */
export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function titleCase(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
