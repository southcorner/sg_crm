import { useEffect, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import api from '../api.js';
import { inr, inr0, num, qs } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, Banner, MonthPicker, Select } from '../components/ui.jsx';
import { AXIS_PROPS, TOOLTIP_STYLE, GRID, inrAxis, monthLabel, seriesColor } from '../charts.js';

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Columns a first click should sort biggest-first. Must match the API whitelist. */
const NUMERIC_DRILL_COLUMNS = new Set(['quantity', 'revenue', 'invoices', 'customers']);

const DRILL_COLUMN_LABELS = {
  name: 'name',
  sku: 'SKU',
  brand: 'brand',
  category: 'category',
  quantity: 'quantity',
  revenue: 'revenue',
  invoices: 'invoice count',
  customers: 'customer count',
};

/** "revenue (high to low)" — what the capped list was ranked by. */
function sortLabel(filters) {
  const column = DRILL_COLUMN_LABELS[filters?.sort] || 'revenue';
  const dir = filters?.sort ? filters.dir : 'desc';
  return `${column} (${dir === 'asc' ? 'low to high' : 'high to low'})`;
}

/** Sortable drill-down header. Three-state: natural → reversed → default. */
function DrillHeader({ label, column, sort, dir, onSort, align }) {
  const active = sort === column;
  return (
    <th
      className={`sortable ${active ? 'active' : ''} ${align === 'right' ? 'right' : ''}`}
      onClick={() => onSort(column)}
      title={active ? 'Click to reverse · click again to clear the sort' : `Sort by ${label}`}
    >
      {label}
      <span className="sort-caret">{active ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
    </th>
  );
}

export default function Performance() {
  const [month, setMonth] = useState(thisMonth());
  const [momMonths, setMomMonths] = useState(12);
  const [momBrand, setMomBrand] = useState('');
  const [momRep, setMomRep] = useState('');
  const [drill, setDrill] = useState({ rep: '', customer: '', brand: '', month: '', sort: '', dir: '' });

  // the model search is debounced so a fast typist does not fire a query per
  // keystroke; `searchInput` drives the box, `search` drives the request
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const summaryQuery = useQuery({
    queryKey: ['performance', 'summary', month],
    queryFn: () => api.get(`/performance/summary${qs({ month })}`),
    placeholderData: keepPreviousData,
  });

  const momQuery = useQuery({
    queryKey: ['performance', 'mom', momMonths, momBrand, momRep, month],
    queryFn: () => api.get(`/performance/mom${qs({ months: momMonths, brand: momBrand, rep: momRep, end: month })}`),
    placeholderData: keepPreviousData,
  });

  const brandQuery = useQuery({
    queryKey: ['performance', 'brands', momMonths, month],
    queryFn: () => api.get(`/performance/brands${qs({ months: Math.min(momMonths, 12), end: month })}`),
    placeholderData: keepPreviousData,
  });

  const productQuery = useQuery({
    queryKey: ['performance', 'products', drill, month, search],
    queryFn: () =>
      api.get(
        `/performance/products${qs({
          rep: drill.rep,
          customer: drill.customer,
          brand: drill.brand,
          month: drill.month || month,
          search,
          sort: drill.sort,
          dir: drill.dir,
        })}`
      ),
    placeholderData: keepPreviousData,
  });

  // filter options come from the visible-rep list, not the summary rows — a rep
  // with no sales in the selected month must still be selectable
  const filtersQuery = useQuery({
    queryKey: ['invoices', 'meta', 'filters'],
    queryFn: () => api.get('/invoices/meta/filters'),
  });

  /**
   * Three-state header click: first sorts the column the way you almost always
   * want it (biggest first for numbers, A→Z for text), second reverses, third
   * drops back to the page default of revenue DESC.
   */
  function toggleDrillSort(column) {
    const natural = NUMERIC_DRILL_COLUMNS.has(column) ? 'desc' : 'asc';
    setDrill((d) => {
      if (d.sort !== column) return { ...d, sort: column, dir: natural };
      if (d.dir === natural) return { ...d, sort: column, dir: natural === 'desc' ? 'asc' : 'desc' };
      return { ...d, sort: '', dir: '' };
    });
  }

  const summary = summaryQuery.data;
  const brandOptions = (summary?.brands || []).map((b) => ({ value: b.id, label: b.name }));
  const repOptions = (filtersQuery.data?.salespersons || []).map((r) => ({ value: r.id, label: r.name }));

  return (
    <div className="page">
      <header className="page-header">
        <h1>Performance</h1>
        <p className="page-sub">
          Every figure is attributed to the invoice’s <strong>effective rep</strong> — the customer’s assignment for
          that date, falling back to the salesperson on the invoice. Void invoices are excluded throughout.
        </p>
      </header>

      <div className="filter-bar">
        <MonthPicker value={month} onChange={(v) => v && setMonth(v)} />
      </div>

      <ErrorBox error={summaryQuery.error} />

      {summary?.pendingInvoices ? (
        <Banner tone="warn">
          {num(summary.pendingInvoices)} invoice(s) in {monthLabel(summary.month)} worth {inr0(summary.pendingAmount)}{' '}
          are still pending line-item sync — they count towards each rep’s total but cannot be split by brand yet.
        </Banner>
      ) : null}

      {/* ---------------- summary table ---------------- */}
      <Card title={`Rep summary · ${monthLabel(month)}`}>
        {summaryQuery.isLoading ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rep</th>
                  <th className="right">Invoices</th>
                  <th className="right">Sales</th>
                  <th className="right">Target</th>
                  <th className="right">Achieved</th>
                  <th className="right">Delta</th>
                  <th>Brand split</th>
                </tr>
              </thead>
              <tbody>
                {summary?.rows?.length ? (
                  summary.rows.map((r) => (
                    <tr key={r.rep_id || 'unattributed'} className={r.rep_id ? '' : 'row-muted'}>
                      <td>
                        {r.rep_id ? (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => setDrill({ ...drill, rep: r.rep_id, month })}
                          >
                            {r.rep_name}
                          </button>
                        ) : (
                          <span title="No assignment and no matching salesperson on the invoice">{r.rep_name}</span>
                        )}
                      </td>
                      <td className="right">{num(r.invoice_count)}</td>
                      <td className="right">{inr(r.sales)}</td>
                      <td className="right">{r.target ? inr(r.target) : '—'}</td>
                      <td className="right">
                        {r.achievement_pct === null ? (
                          '—'
                        ) : (
                          <AchievementBar pct={r.achievement_pct} />
                        )}
                      </td>
                      <td className={`right ${r.target && r.delta < 0 ? 'money-due' : ''}`}>
                        {r.target ? inr(r.delta) : '—'}
                      </td>
                      <td>
                        <div className="chip-row">
                          {r.brands.length ? (
                            r.brands.map((b) => (
                              <span key={b.brand_id ?? 'none'} className="pill">
                                {b.brand_name} {inr0(b.sales)}
                                {b.target ? ` / ${inr0(b.target)}` : ''}
                              </span>
                            ))
                          ) : (
                            <span className="sub">no line items</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={7}>No invoices in this month.</EmptyRow>
                )}
              </tbody>
              {summary?.rows?.length ? (
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <th className="right">{num(summary.totals.invoice_count)}</th>
                    <th className="right">{inr(summary.totals.sales)}</th>
                    <th className="right">{summary.totals.target ? inr(summary.totals.target) : '—'}</th>
                    <th className="right">
                      {summary.totals.achievement_pct === null ? '—' : `${summary.totals.achievement_pct}%`}
                    </th>
                    <th className="right">{summary.totals.target ? inr(summary.totals.delta) : '—'}</th>
                    <th />
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        )}
      </Card>

      {/* ---------------- month on month ---------------- */}
      <Card
        title="Month on month"
        actions={
          <div className="filters">
            <Select
              label="Months"
              value={momMonths}
              onChange={(v) => setMomMonths(Number(v))}
              options={[6, 12, 24].map((n) => ({ value: n, label: `${n} months` }))}
            />
            <Select
              label="Rep"
              value={momRep}
              onChange={setMomRep}
              options={repOptions}
              allLabel="All reps"
            />
            <Select label="Brand" value={momBrand} onChange={setMomBrand} options={brandOptions} allLabel="All brands" />
          </div>
        }
      >
        <ErrorBox error={momQuery.error} />
        {momBrand && momQuery.data?.pendingInvoices ? (
          <Banner tone="warn">
            Brand-filtered: {num(momQuery.data.pendingInvoices)} invoice(s) in this window have no line items yet and
            are not in the chart.
          </Banner>
        ) : null}

        {momQuery.isLoading ? (
          <Loading />
        ) : momQuery.data?.series?.length ? (
          <>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={momQuery.data.chart} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="month" tickFormatter={monthLabel} {...AXIS_PROPS} />
                  <YAxis tickFormatter={inrAxis} width={64} {...AXIS_PROPS} />
                  <Tooltip
                    {...TOOLTIP_STYLE}
                    formatter={(value, name) => [inr(value), name]}
                    labelFormatter={monthLabel}
                  />
                  {momQuery.data.series.length > 1 ? <Legend iconType="plainline" /> : null}
                  {momQuery.data.series.map((s, i) => (
                    <Line
                      key={s.rep_id || 'unattributed'}
                      type="monotone"
                      dataKey={s.rep_name}
                      stroke={seriesColor(i)}
                      strokeWidth={2}
                      dot={{ r: 3, strokeWidth: 0, fill: seriesColor(i) }}
                      activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* the table view is the accessible twin of the chart above */}
            <div className="table-wrap">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Rep</th>
                    {momQuery.data.months.map((m) => (
                      <th key={m} className="right">
                        {monthLabel(m)}
                      </th>
                    ))}
                    <th className="right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {momQuery.data.series.map((s, i) => (
                    <tr key={s.rep_id || 'unattributed'}>
                      <td className="nowrap">
                        <span className="series-dot" style={{ background: seriesColor(i) }} />
                        {s.rep_name}
                      </td>
                      {s.points.map((p) => (
                        <td key={p.month} className="right">
                          {p.amount ? inr0(p.amount) : '—'}
                        </td>
                      ))}
                      <td className="right">{inr0(s.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="muted-text">No sales in this window.</p>
        )}
      </Card>

      {/* ---------------- brand rollup ---------------- */}
      <Card title="Sales by brand">
        <ErrorBox error={brandQuery.error} />
        {brandQuery.data?.pendingInvoices ? (
          <Banner tone="warn">
            {num(brandQuery.data.pendingInvoices)} invoice(s) worth {inr0(brandQuery.data.pendingAmount)} are pending
            line-item sync and are missing from this section.
          </Banner>
        ) : null}

        {brandQuery.isLoading ? (
          <Loading />
        ) : brandQuery.data?.brands?.length ? (
          <>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={brandQuery.data.chart} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="month" tickFormatter={monthLabel} {...AXIS_PROPS} />
                  <YAxis tickFormatter={inrAxis} width={64} {...AXIS_PROPS} />
                  <Tooltip
                    {...TOOLTIP_STYLE}
                    cursor={{ fill: 'rgba(28, 36, 48, 0.04)' }}
                    formatter={(value, name) => [inr(value), name]}
                    labelFormatter={monthLabel}
                  />
                  {brandQuery.data.brands.length > 1 ? <Legend /> : null}
                  {brandQuery.data.brands.map((b, i) => (
                    <Bar
                      key={b.brand_id ?? 'none'}
                      dataKey={b.brand_name}
                      stackId="brands"
                      fill={seriesColor(i)}
                      stroke="#ffffff"
                      strokeWidth={2}
                      radius={i === brandQuery.data.brands.length - 1 ? [4, 4, 0, 0] : 0}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="table-wrap">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Brand</th>
                    {brandQuery.data.months.map((m) => (
                      <th key={m} className="right">
                        {monthLabel(m)}
                      </th>
                    ))}
                    <th className="right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {brandQuery.data.brands.map((b, i) => (
                    <tr key={b.brand_id ?? 'none'}>
                      <td className="nowrap">
                        <span className="series-dot" style={{ background: seriesColor(i) }} />
                        {b.brand_name}
                      </td>
                      {brandQuery.data.months.map((m) => {
                        const hit = brandQuery.data.rows.find(
                          (r) => r.month === m && (r.brand_id ?? null) === b.brand_id
                        );
                        return (
                          <td key={m} className="right">
                            {hit ? inr0(hit.amount) : '—'}
                          </td>
                        );
                      })}
                      <td className="right">{inr0(b.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="muted-text">
            Nothing to show — brand figures need synced invoice line items and at least one mapped item.
          </p>
        )}
      </Card>

      {/* ---------------- product drill-down ---------------- */}
      <Card
        title="Product drill-down"
        actions={
          <div className="filters">
            <label className="search-field">
              <span>Model</span>
              <span className="search-input">
                <input
                  type="text"
                  placeholder="Search name or SKU…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
                {searchInput ? (
                  <button
                    type="button"
                    className="search-clear"
                    aria-label="Clear model search"
                    title="Clear"
                    onClick={() => setSearchInput('')}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            </label>
            <Select label="Rep" value={drill.rep} onChange={(v) => setDrill({ ...drill, rep: v })} options={repOptions} allLabel="All reps" />
            <Select
              label="Brand"
              value={drill.brand}
              onChange={(v) => setDrill({ ...drill, brand: v })}
              options={[...brandOptions, { value: 'none', label: 'Unmapped' }]}
              allLabel="All brands"
            />
            <MonthPicker label="Month" value={drill.month || month} onChange={(v) => setDrill({ ...drill, month: v })} />
            {drill.customer ? (
              <button type="button" className="btn ghost small" onClick={() => setDrill({ ...drill, customer: '' })}>
                Clear customer
              </button>
            ) : null}
          </div>
        }
      >
        <ErrorBox error={productQuery.error} />
        {productQuery.data?.pendingInvoices ? (
          <Banner tone="warn">
            {num(productQuery.data.pendingInvoices)} invoice(s) in this window have no line items yet and are missing
            from this table.
          </Banner>
        ) : null}
        {productQuery.data ? (
          <div className="drill-count">
            {num(productQuery.data.matched)} model{productQuery.data.matched === 1 ? '' : 's'}
            {productQuery.data.filters?.search ? (
              <>
                {' '}matching “<strong>{productQuery.data.filters.search}</strong>”
              </>
            ) : null}
            {productQuery.data.truncated ? (
              <> · showing the top {num(productQuery.data.rows.length)} by {sortLabel(productQuery.data.filters)}</>
            ) : null}
            {drill.sort ? (
              <>
                {' '}·{' '}
                <button type="button" className="link-button" onClick={() => setDrill({ ...drill, sort: '', dir: '' })}>
                  clear sort
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <DrillHeader label="Item" column="name" sort={drill.sort} dir={drill.dir} onSort={toggleDrillSort} />
                <DrillHeader label="SKU" column="sku" sort={drill.sort} dir={drill.dir} onSort={toggleDrillSort} />
                <DrillHeader label="Brand" column="brand" sort={drill.sort} dir={drill.dir} onSort={toggleDrillSort} />
                <DrillHeader label="Qty" column="quantity" sort={drill.sort} dir={drill.dir} onSort={toggleDrillSort} align="right" />
                <DrillHeader label="Invoices" column="invoices" sort={drill.sort} dir={drill.dir} onSort={toggleDrillSort} align="right" />
                <DrillHeader label="Customers" column="customers" sort={drill.sort} dir={drill.dir} onSort={toggleDrillSort} align="right" />
                <DrillHeader label="Revenue" column="revenue" sort={drill.sort} dir={drill.dir} onSort={toggleDrillSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {productQuery.data?.rows?.length ? (
                productQuery.data.rows.map((r) => (
                  // group_key is unique per row by construction; the fallback
                  // only matters for a cached response from an older server
                  <tr key={`${r.group_key || r.item_id || r.item_name}-${r.brand_id ?? 'none'}`}>
                    <td>{r.item_name || '—'}</td>
                    <td className="mono">{r.sku || '—'}</td>
                    <td>{r.brand_name}</td>
                    <td className="right">{num(r.quantity)}</td>
                    <td className="right">{num(r.invoice_count)}</td>
                    <td className="right">{num(r.customer_count)}</td>
                    <td className="right">{inr(r.revenue)}</td>
                  </tr>
                ))
              ) : (
                <EmptyRow colSpan={7}>
                  {productQuery.isLoading
                    ? 'Loading…'
                    : search
                      ? `No model matches “${search}” in this window.`
                      : 'No line items match these filters.'}
                </EmptyRow>
              )}
            </tbody>
            {productQuery.data?.rows?.length ? (
              <tfoot>
                <tr>
                  <th colSpan={3}>{num(productQuery.data.totals.items)} items</th>
                  <th className="right">{num(productQuery.data.totals.quantity)}</th>
                  <th colSpan={2} />
                  <th className="right">{inr(productQuery.data.totals.revenue)}</th>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
        <p className="muted-text">
          Revenue is each line’s pro-rata share of its invoice total, so brand and product figures reconcile with the
          rep totals above. Need one customer? Open them from{' '}
          <Link className="link" to="/customers">
            Customers
          </Link>{' '}
          — their invoices carry the same attribution.
        </p>
      </Card>
    </div>
  );
}

function AchievementBar({ pct }) {
  const capped = Math.max(0, Math.min(100, pct));
  const tone = pct >= 100 ? 'ok' : pct >= 75 ? 'warn' : 'bad';
  return (
    <span className="achievement">
      <span className="achievement-track">
        <span className={`achievement-fill ${tone}`} style={{ width: `${capped}%` }} />
      </span>
      <span className="achievement-label">{pct}%</span>
    </span>
  );
}
