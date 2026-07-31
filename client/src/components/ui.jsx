/** Small presentational building blocks shared by the phase-1 pages. */

import { titleCase } from '../format.js';

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      )}
      {children}
    </section>
  );
}

export function KpiCard({ label, value, sub, tone = '' }) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  );
}

const STATUS_TONE = {
  paid: 'ok',
  sent: 'info',
  unpaid: 'info',
  draft: 'muted',
  void: 'muted',
  overdue: 'bad',
  partially_paid: 'warn',
  ok: 'ok',
  error: 'bad',
  halted: 'warn',
  running: 'info',
};

export function StatusChip({ value, tone }) {
  if (!value) return <span className="chip muted">—</span>;
  const key = String(value).toLowerCase();
  return <span className={`chip ${tone || STATUS_TONE[key] || 'muted'}`}>{titleCase(key)}</span>;
}

export function Loading({ label = 'Loading…' }) {
  return <div className="state-msg">{label}</div>;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="state-msg error">{error.message || String(error)}</div>;
}

export function EmptyRow({ colSpan, children = 'Nothing to show' }) {
  return (
    <tr>
      <td colSpan={colSpan} className="empty-cell">
        {children}
      </td>
    </tr>
  );
}

export function Pagination({ page, pages, total, onPage }) {
  if (!total) return null;
  return (
    <div className="pager">
      <span className="pager-info">
        Page {page} of {pages} · {total.toLocaleString('en-IN')} rows
      </span>
      <div className="pager-buttons">
        <button type="button" disabled={page <= 1} onClick={() => onPage(1)}>
          «
        </button>
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Prev
        </button>
        <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
        <button type="button" disabled={page >= pages} onClick={() => onPage(pages)}>
          »
        </button>
      </div>
    </div>
  );
}

/** Clickable table header that toggles sort direction. */
export function SortHeader({ label, column, sort, dir, onSort, align }) {
  const active = sort === column;
  return (
    <th
      className={`sortable ${active ? 'active' : ''} ${align === 'right' ? 'right' : ''}`}
      onClick={() => onSort(column, active && dir === 'ASC' ? 'DESC' : 'ASC')}
    >
      {label}
      <span className="sort-caret">{active ? (dir === 'ASC' ? '▲' : '▼') : ''}</span>
    </th>
  );
}

export function ProgressBar({ value, max, label }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="progress-wrap">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-label">{label || `${pct}%`}</div>
    </div>
  );
}

export function Banner({ tone = 'info', children }) {
  if (!children) return null;
  return <div className={`banner ${tone}`}>{children}</div>;
}

/** Native month input — the whole app works in 'YYYY-MM' strings. */
export function MonthPicker({ value, onChange, label = 'Month', max, min }) {
  return (
    <label className="month-picker">
      <span>{label}</span>
      <input type="month" value={value || ''} max={max} min={min} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function Select({ label, value, onChange, options, allLabel }) {
  return (
    <label className="select-field">
      {label ? <span>{label}</span> : null}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {allLabel ? <option value="">{allLabel}</option> : null}
        {options.map((o) => (
          <option key={String(o.value)} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          className={active === t.key ? 'tab active' : 'tab'}
          onClick={() => onChange(t.key)}
          disabled={t.disabled}
          title={t.disabled ? 'Lands in a later phase' : undefined}
        >
          {t.label}
          {t.count !== undefined ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
