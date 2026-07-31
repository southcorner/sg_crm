'use strict';

/**
 * Performance rollups.
 *
 * Rules that hold everywhere in this file:
 *   * void invoices are excluded, always;
 *   * a sale belongs to the invoice's EFFECTIVE rep (services/attribution.js),
 *     never blindly to the Zoho salesperson stamped on the invoice;
 *   * brand-level money comes from invoice_line_items joined items →
 *     item_brand_map, so an invoice whose line items have not been synced yet
 *     contributes nothing to brand figures. Every brand-aware result therefore
 *     carries `pendingInvoices` (and `pendingByMonth`) so the UI can say
 *     "N invoices pending line-item sync" instead of silently under-reporting.
 *
 * Line items are stored ex-tax while an invoice total is inc-tax, so a line's
 * brand amount is its pro-rata share of the invoice total
 * (item_total / sum(item_total) * invoice.total). That keeps
 * SUM(brand amounts) == SUM(invoice totals) for invoices that have line items.
 */

const { getDb } = require('../db/connection');
const attribution = require('./attribution');
const { invoiceRepCte } = attribution;

/**
 * Parameters for the global rep scope baked into invoiceRepCte / lineBrandCte /
 * pendingLineItemInvoices. Every statement in this file that uses one of those
 * must spread this into its bindings; it is `{}` when the scope is off, so
 * spreading is always safe.
 */
function scopeParams() {
  return attribution.invoiceScopeFilter('i').params;
}

// ---------------------------------------------------------------------------
// month helpers
// ---------------------------------------------------------------------------

function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(month, delta) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The `n` months ending at (and including) `endMonth`, oldest first. */
function monthList(endMonth, n) {
  const count = Math.max(1, Math.min(60, Number(n) || 12));
  const end = endMonth || currentMonth();
  return Array.from({ length: count }, (_, i) => shiftMonth(end, i - (count - 1)));
}

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

/**
 * Line items with their brand and pro-rata share of the invoice total.
 * Carries the global rep scope on its parent invoice, exactly like
 * invoiceRepCte — bind scopeParams() alongside.
 */
function lineBrandCte({ where = '', name = 'line_brand' } = {}) {
  const scope = attribution.invoiceScopeFilter('inv');
  return `${name} AS (
    SELECT li.invoice_id,
           li.item_id,
           li.name AS item_name,
           li.sku,
           li.quantity,
           li.item_total,
           substr(inv.invoice_date, 1, 7) AS month,
           m.brand_id,
           CASE WHEN ls.line_sum > 0 THEN li.item_total / ls.line_sum * inv.total ELSE 0 END AS amount
      FROM invoice_line_items li
      JOIN invoices inv ON inv.zoho_invoice_id = li.invoice_id
      JOIN (SELECT invoice_id, SUM(item_total) AS line_sum
              FROM invoice_line_items GROUP BY invoice_id) ls
        ON ls.invoice_id = li.invoice_id
      LEFT JOIN item_brand_map m ON m.item_id = li.item_id
     WHERE inv.status <> 'void'
       AND inv.invoice_date IS NOT NULL
       AND ${scope.sql}
       ${where ? `AND ${where}` : ''}
  )`;
}

const NO_LINE_ITEMS = `NOT EXISTS (SELECT 1 FROM invoice_line_items li WHERE li.invoice_id = i.zoho_invoice_id)`;

/** Non-void invoices in a window that have no line items yet (scoped). */
function pendingLineItemInvoices({ where = '', params = {} } = {}) {
  const db = getDb();
  const scope = attribution.invoiceScopeFilter('i');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(i.total), 0) AS amount
         FROM invoices i
        WHERE i.status <> 'void' AND i.invoice_date IS NOT NULL AND ${NO_LINE_ITEMS}
          AND ${scope.sql}
          ${where ? `AND ${where}` : ''}`
    )
    .get({ ...params, ...scope.params });
  return { count: row.n, amount: row.amount };
}

function repDirectory() {
  return new Map(
    getDb()
      .prepare('SELECT zoho_salesperson_id AS id, name, is_active FROM salespersons')
      .all()
      .map((r) => [r.id, r])
  );
}

function brandDirectory() {
  return new Map(
    getDb()
      .prepare('SELECT id, name, color, is_active, sort_order FROM brands ORDER BY sort_order, name')
      .all()
      .map((b) => [b.id, b])
  );
}

const repName = (dir, id) => (id ? dir.get(id)?.name || `Unknown rep (${id})` : 'Unattributed');
const brandName = (dir, id) => (id ? dir.get(id)?.name || `Brand #${id}` : 'Unmapped');
const pct = (value, target) => (target > 0 ? Math.round((value / target) * 1000) / 10 : null);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// summary(month)
// ---------------------------------------------------------------------------

/**
 * Per effective-rep sales vs target for one month, with the per-brand breakdown
 * (overall target = targets row with brand_id NULL).
 */
function summary(month) {
  const db = getDb();
  const m = month || currentMonth();
  const params = { month: m, ...scopeParams() };

  const repRows = db
    .prepare(
      `WITH ${invoiceRepCte({ where: 'substr(i.invoice_date, 1, 7) = @month' })}
       SELECT r.rep_id, COUNT(*) AS invoice_count, COALESCE(SUM(r.total), 0) AS sales
         FROM invoice_rep r
        GROUP BY r.rep_id`
    )
    .all(params);

  const brandRows = db
    .prepare(
      `WITH ${invoiceRepCte({ where: 'substr(i.invoice_date, 1, 7) = @month' })},
            ${lineBrandCte({ where: 'substr(inv.invoice_date, 1, 7) = @month' })}
       SELECT r.rep_id, lb.brand_id, COALESCE(SUM(lb.amount), 0) AS sales
         FROM line_brand lb
         JOIN invoice_rep r ON r.invoice_id = lb.invoice_id
        GROUP BY r.rep_id, lb.brand_id`
    )
    .all(params);

  // a hidden rep's target must not conjure a row for them in a scoped summary
  const targetRows = db
    .prepare('SELECT salesperson_id, brand_id, target_amount FROM targets WHERE month = ?')
    .all(m)
    .filter((t) => attribution.isRepVisible(t.salesperson_id));

  const reps = repDirectory();
  const brands = brandDirectory();

  // rep_id -> accumulator
  const acc = new Map();
  const bucket = (id) => {
    const key = id || null;
    if (!acc.has(key)) {
      acc.set(key, { rep_id: key, sales: 0, invoice_count: 0, target: 0, brands: new Map() });
    }
    return acc.get(key);
  };
  const brandBucket = (row, brandId) => {
    const key = brandId ?? null;
    if (!row.brands.has(key)) row.brands.set(key, { brand_id: key, sales: 0, target: 0 });
    return row.brands.get(key);
  };

  for (const r of repRows) {
    const row = bucket(r.rep_id);
    row.sales = r.sales;
    row.invoice_count = r.invoice_count;
  }
  for (const b of brandRows) {
    brandBucket(bucket(b.rep_id), b.brand_id).sales = b.sales;
  }
  for (const t of targetRows) {
    const row = bucket(t.salesperson_id);
    if (t.brand_id === null) row.target = t.target_amount;
    else brandBucket(row, t.brand_id).target = t.target_amount;
  }

  const rows = [...acc.values()]
    .map((r) => ({
      rep_id: r.rep_id,
      rep_name: repName(reps, r.rep_id),
      is_active: r.rep_id ? Boolean(reps.get(r.rep_id)?.is_active ?? 1) : false,
      sales: round2(r.sales),
      invoice_count: r.invoice_count,
      target: round2(r.target),
      achievement_pct: pct(r.sales, r.target),
      delta: round2(r.sales - r.target),
      brands: [...r.brands.values()]
        .map((b) => ({
          brand_id: b.brand_id,
          brand_name: brandName(brands, b.brand_id),
          sales: round2(b.sales),
          target: round2(b.target),
          achievement_pct: pct(b.sales, b.target),
          delta: round2(b.sales - b.target),
        }))
        .sort((a, b) => b.sales - a.sales),
    }))
    .sort((a, b) => b.sales - a.sales);

  const totals = rows.reduce(
    (t, r) => ({
      sales: round2(t.sales + r.sales),
      invoice_count: t.invoice_count + r.invoice_count,
      target: round2(t.target + r.target),
    }),
    { sales: 0, invoice_count: 0, target: 0 }
  );
  totals.achievement_pct = pct(totals.sales, totals.target);
  totals.delta = round2(totals.sales - totals.target);

  const pending = pendingLineItemInvoices({
    where: 'substr(i.invoice_date, 1, 7) = @month',
    params,
  });

  return {
    month: m,
    rows,
    totals,
    brands: [...brands.values()].map((b) => ({ id: b.id, name: b.name, is_active: Boolean(b.is_active) })),
    pendingInvoices: pending.count,
    pendingAmount: round2(pending.amount),
  };
}

// ---------------------------------------------------------------------------
// mom(rep?, months, brand?)
// ---------------------------------------------------------------------------

/**
 * Month-on-month sales per effective rep. With `brand` the amounts come from
 * line items (so `pendingInvoices` matters); without it, from invoice totals.
 */
function mom({ rep = null, months = 12, brand = null, endMonth = null } = {}) {
  const db = getDb();
  const list = monthList(endMonth, months);
  const from = list[0];
  const to = list[list.length - 1];
  const params = { from, to, ...scopeParams() };

  const window = 'substr(i.invoice_date, 1, 7) BETWEEN @from AND @to';
  const brandFilter = brand === 'none' ? 'lb.brand_id IS NULL' : brand ? 'lb.brand_id = @brand' : null;
  if (brand && brand !== 'none') params.brand = Number(brand);
  if (rep) params.rep = rep;

  const sql = brandFilter
    ? `WITH ${invoiceRepCte({ where: window })},
            ${lineBrandCte({ where: 'substr(inv.invoice_date, 1, 7) BETWEEN @from AND @to' })}
       SELECT r.rep_id, r.month, COALESCE(SUM(lb.amount), 0) AS amount,
              COUNT(DISTINCT r.invoice_id) AS invoice_count
         FROM line_brand lb
         JOIN invoice_rep r ON r.invoice_id = lb.invoice_id
        WHERE ${brandFilter} ${rep ? 'AND r.rep_id = @rep' : ''}
        GROUP BY r.rep_id, r.month`
    : `WITH ${invoiceRepCte({ where: window })}
       SELECT r.rep_id, r.month, COALESCE(SUM(r.total), 0) AS amount, COUNT(*) AS invoice_count
         FROM invoice_rep r
        ${rep ? 'WHERE r.rep_id = @rep' : ''}
        GROUP BY r.rep_id, r.month`;

  const rows = db.prepare(sql).all(params);
  const reps = repDirectory();

  const byRep = new Map();
  for (const r of rows) {
    const key = r.rep_id || null;
    if (!byRep.has(key)) byRep.set(key, new Map());
    byRep.get(key).set(r.month, { amount: r.amount, invoice_count: r.invoice_count });
  }

  const series = [...byRep.entries()]
    .map(([repId, monthMap]) => {
      const points = list.map((mo) => ({
        month: mo,
        amount: round2(monthMap.get(mo)?.amount || 0),
        invoice_count: monthMap.get(mo)?.invoice_count || 0,
      }));
      return {
        rep_id: repId,
        rep_name: repName(reps, repId),
        total: round2(points.reduce((s, p) => s + p.amount, 0)),
        points,
      };
    })
    .sort((a, b) => b.total - a.total);

  // recharts-friendly: one object per month with a key per rep
  const chart = list.map((mo) => {
    const point = { month: mo };
    let total = 0;
    for (const s of series) {
      const amount = s.points.find((p) => p.month === mo)?.amount || 0;
      point[s.rep_name] = amount;
      total += amount;
    }
    point.__total = round2(total);
    return point;
  });

  const pending = pendingLineItemInvoices({
    where: 'substr(i.invoice_date, 1, 7) BETWEEN @from AND @to',
    params: { from, to },
  });

  return {
    months: list,
    from,
    to,
    brand: brand || null,
    rep: rep || null,
    series,
    chart,
    pendingInvoices: brandFilter ? pending.count : 0,
    pendingAmount: brandFilter ? round2(pending.amount) : 0,
  };
}

// ---------------------------------------------------------------------------
// products(filters)
// ---------------------------------------------------------------------------

/**
 * Sortable columns of the drill-down, keyed by the name the API accepts.
 * A whitelist, not a passthrough: the value is spliced straight into ORDER BY,
 * so nothing outside this map can ever reach the SQL. Text sorts are
 * case-insensitive; NULL skus/categories sort last whichever way you go.
 */
const PRODUCT_SORTS = {
  name: 'item_name COLLATE NOCASE',
  sku: 'sku COLLATE NOCASE',
  brand: 'brand_name COLLATE NOCASE',
  category: 'category_name COLLATE NOCASE',
  quantity: 'quantity',
  revenue: 'revenue',
  invoices: 'invoice_count',
  customers: 'customer_count',
};

const PRODUCT_SORT_KEYS = Object.keys(PRODUCT_SORTS);
const DEFAULT_PRODUCT_ORDER = 'revenue DESC, item_name COLLATE NOCASE ASC';

/**
 * Escape a user string for use inside a LIKE pattern. The backslash is escaped
 * FIRST — doing it after % and _ would re-escape the escapes.
 */
function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * Line-item level drill-down: item, quantity, revenue.
 *
 * `search` matches the model name OR its SKU (case-insensitive substring).
 * `sort`/`dir` order the result IN SQL — the list is capped by `limit`, so
 * sorting client-side would only reorder whichever slice came back.
 */
function products({
  rep = null,
  customer = null,
  brand = null,
  month = null,
  months = 12,
  endMonth = null,
  limit = 200,
  search = null,
  sort = null,
  dir = null,
} = {}) {
  const db = getDb();
  const params = { ...scopeParams() };
  const invoiceWhere = [];
  const lineWhere = [];

  if (month) {
    params.month = month;
    invoiceWhere.push('substr(i.invoice_date, 1, 7) = @month');
    lineWhere.push('substr(inv.invoice_date, 1, 7) = @month');
  } else {
    const list = monthList(endMonth, months);
    params.from = list[0];
    params.to = list[list.length - 1];
    invoiceWhere.push('substr(i.invoice_date, 1, 7) BETWEEN @from AND @to');
    lineWhere.push('substr(inv.invoice_date, 1, 7) BETWEEN @from AND @to');
  }
  if (customer) {
    params.customer = customer;
    invoiceWhere.push('i.customer_id = @customer');
    lineWhere.push('inv.customer_id = @customer');
  }

  const outer = [];
  if (rep) {
    params.rep = rep;
    outer.push('r.rep_id = @rep');
  }
  if (brand === 'none') outer.push('lb.brand_id IS NULL');
  else if (brand) {
    params.brand = Number(brand);
    outer.push('lb.brand_id = @brand');
  }
  const term = search === null || search === undefined ? '' : String(search).trim();
  if (term) {
    params.search = likePattern(term);
    // WHERE, not HAVING: name and sku are still row-level values here, so
    // filtering before the grouping is both correct and cheaper
    outer.push(
      `(COALESCE(it.name, lb.item_name) LIKE @search ESCAPE '\\'
        OR COALESCE(it.sku, lb.sku) LIKE @search ESCAPE '\\')`
    );
  }
  params.limit = Math.max(1, Math.min(1000, Number(limit) || 200));

  const sortKey = sort && Object.prototype.hasOwnProperty.call(PRODUCT_SORTS, sort) ? sort : null;
  const direction = String(dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderBy = sortKey
    ? `${PRODUCT_SORTS[sortKey]} ${direction} NULLS LAST, item_name COLLATE NOCASE ASC`
    : DEFAULT_PRODUCT_ORDER;

  // shared by the page query and the "how many matched" count
  const ctes = `${invoiceRepCte({ where: invoiceWhere.join(' AND ') })},
            ${lineBrandCte({ where: lineWhere.join(' AND ') })}`;
  /**
   * One row per model, keyed by item_id — NOT by the line's name. Zoho snapshots
   * the item name onto each line, so the same item can carry names that differ
   * invisibly (stray whitespace) between invoices; grouping on the name split
   * such an item into two identical-looking rows that then collided on the
   * client's React key. Lines with no item_id at all (ad-hoc) still group by
   * their name, which is all they have.
   */
  const GROUP_KEY = `COALESCE(lb.item_id, '~adhoc~' || COALESCE(lb.item_name, ''))`;

  const selectBody = `
         FROM line_brand lb
         JOIN invoice_rep r ON r.invoice_id = lb.invoice_id
         LEFT JOIN items it ON it.zoho_item_id = lb.item_id
         LEFT JOIN brands b ON b.id = lb.brand_id
        ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
        GROUP BY group_key, lb.brand_id`;

  const rows = db
    .prepare(
      `WITH ${ctes}
       SELECT ${GROUP_KEY} AS group_key,
              lb.item_id,
              COALESCE(it.name, MIN(lb.item_name)) AS item_name,
              COALESCE(it.sku, MIN(lb.sku)) AS sku,
              it.category_name,
              lb.brand_id,
              b.name AS brand_name,
              SUM(lb.quantity) AS quantity,
              SUM(lb.amount) AS revenue,
              COUNT(DISTINCT lb.invoice_id) AS invoice_count,
              COUNT(DISTINCT r.customer_id) AS customer_count
        ${selectBody}
        ORDER BY ${orderBy}
        LIMIT @limit`
    )
    .all(params);

  // how many models match before the cap, so the UI can say "top 200 of 512"
  const countParams = { ...params };
  delete countParams.limit;
  const matched = db
    .prepare(
      `WITH ${ctes}
       SELECT COUNT(*) AS n FROM (
         SELECT ${GROUP_KEY} AS group_key, lb.brand_id
         ${selectBody}
       )`
    )
    .get(countParams).n;

  // pendingLineItemInvoices only knows the invoice-window clause, so strip the
  // params that belong to the outer query (it re-adds the scope itself)
  const pendingParams = { ...params };
  delete pendingParams.limit;
  delete pendingParams.rep;
  delete pendingParams.brand;
  delete pendingParams.search;
  for (const key of Object.keys(scopeParams())) delete pendingParams[key];
  const pending = pendingLineItemInvoices({ where: invoiceWhere.join(' AND '), params: pendingParams });

  return {
    rows: rows.map((r) => ({
      ...r,
      brand_name: r.brand_id ? r.brand_name : 'Unmapped',
      quantity: round2(r.quantity),
      revenue: round2(r.revenue),
    })),
    totals: {
      revenue: round2(rows.reduce((s, r) => s + r.revenue, 0)),
      quantity: round2(rows.reduce((s, r) => s + r.quantity, 0)),
      items: rows.length,
    },
    filters: {
      rep,
      customer,
      brand,
      month: month || null,
      months: month ? 1 : months,
      search: term || null,
      sort: sortKey,
      dir: sortKey ? direction.toLowerCase() : null,
    },
    // `matched` counts every model the filters select; `rows` is the capped
    // slice, so the UI can honestly say "showing top 200 of 512"
    matched,
    limit: params.limit,
    truncated: matched > rows.length,
    pendingInvoices: pending.count,
    pendingAmount: round2(pending.amount),
  };
}

// ---------------------------------------------------------------------------
// brand rollup
// ---------------------------------------------------------------------------

/**
 * Sales by brand per month. Invoices without line items cannot be attributed to
 * a brand at all — they are excluded and counted in `pendingInvoices` /
 * `pendingByMonth`.
 */
function brandRollup({ months = 6, endMonth = null, rep = null } = {}) {
  const db = getDb();
  const list = monthList(endMonth, months);
  const params = { from: list[0], to: list[list.length - 1], ...scopeParams() };
  if (rep) params.rep = rep;

  const rows = db
    .prepare(
      `WITH ${invoiceRepCte({ where: 'substr(i.invoice_date, 1, 7) BETWEEN @from AND @to' })},
            ${lineBrandCte({ where: 'substr(inv.invoice_date, 1, 7) BETWEEN @from AND @to' })}
       SELECT lb.month, lb.brand_id, COALESCE(SUM(lb.amount), 0) AS amount,
              COUNT(DISTINCT lb.invoice_id) AS invoice_count
         FROM line_brand lb
         JOIN invoice_rep r ON r.invoice_id = lb.invoice_id
        ${rep ? 'WHERE r.rep_id = @rep' : ''}
        GROUP BY lb.month, lb.brand_id`
    )
    .all(params);

  const brands = brandDirectory();
  const seen = new Map();
  for (const r of rows) {
    const key = r.brand_id ?? 'none';
    if (!seen.has(key)) {
      seen.set(key, { brand_id: r.brand_id ?? null, brand_name: brandName(brands, r.brand_id), total: 0 });
    }
    seen.get(key).total = round2(seen.get(key).total + r.amount);
  }
  const brandList = [...seen.values()].sort((a, b) => b.total - a.total);

  const chart = list.map((mo) => {
    const point = { month: mo };
    for (const b of brandList) {
      const hit = rows.find((r) => r.month === mo && (r.brand_id ?? null) === b.brand_id);
      point[b.brand_name] = round2(hit?.amount || 0);
    }
    return point;
  });

  const pendingScope = attribution.invoiceScopeFilter('i');
  const pendingByMonth = db
    .prepare(
      `SELECT substr(i.invoice_date, 1, 7) AS month, COUNT(*) AS n, COALESCE(SUM(i.total), 0) AS amount
         FROM invoices i
        WHERE i.status <> 'void' AND i.invoice_date IS NOT NULL AND ${NO_LINE_ITEMS}
          AND substr(i.invoice_date, 1, 7) BETWEEN @from AND @to
          AND ${pendingScope.sql}
        GROUP BY month
        ORDER BY month`
    )
    .all({ from: params.from, to: params.to, ...pendingScope.params });

  const pendingTotal = pendingByMonth.reduce((s, r) => s + r.n, 0);

  return {
    months: list,
    brands: brandList,
    rows: rows.map((r) => ({
      month: r.month,
      brand_id: r.brand_id ?? null,
      brand_name: brandName(brands, r.brand_id),
      amount: round2(r.amount),
      invoice_count: r.invoice_count,
    })),
    chart,
    total: round2(brandList.reduce((s, b) => s + b.total, 0)),
    pendingInvoices: pendingTotal,
    pendingAmount: round2(pendingByMonth.reduce((s, r) => s + r.amount, 0)),
    pendingByMonth: pendingByMonth.map((r) => ({ month: r.month, count: r.n, amount: round2(r.amount) })),
  };
}

/** Current-month brand split — the Dashboard mini-section. */
function mtdBrands({ now = new Date() } = {}) {
  const roll = brandRollup({ months: 1, endMonth: currentMonth(now) });
  return {
    month: roll.months[0],
    brands: roll.brands,
    total: roll.total,
    pendingInvoices: roll.pendingInvoices,
    pendingAmount: roll.pendingAmount,
  };
}

// ---------------------------------------------------------------------------
// targets
// ---------------------------------------------------------------------------

/** The rep × (overall + brand) target grid for a month. */
function getTargets(month) {
  const db = getDb();
  const m = month || currentMonth();
  // the grid only offers reps the CRM is operating on — you cannot set a target
  // for someone whose sales you cannot see
  const rows = db
    .prepare('SELECT id, salesperson_id, month, brand_id, target_amount, note FROM targets WHERE month = ?')
    .all(m)
    .filter((r) => attribution.isRepVisible(r.salesperson_id));

  const reps = attribution
    .listReps({ visibleOnly: true })
    .map((r) => ({ id: r.id, name: r.name, is_active: r.is_active }));
  const brands = db
    .prepare('SELECT id, name FROM brands WHERE is_active = 1 ORDER BY sort_order, name')
    .all();

  const achieved = summary(m);
  const achievedByRep = new Map(achieved.rows.map((r) => [r.rep_id, r]));

  return {
    month: m,
    reps: reps.map((r) => {
      const a = achievedByRep.get(r.id);
      return { ...r, sales: a ? a.sales : 0 };
    }),
    brands,
    rows: rows.map((r) => ({ ...r, brand_id: r.brand_id ?? null })),
  };
}

/** Bulk upsert of grid cells. Idempotent — the unique index is the merge key. */
function upsertTargets(month, cells) {
  const db = getDb();
  const m = month;

  // Validate up front so a bad id is a 400 with a useful message rather than a
  // raw SQLite foreign-key error escaping as a 500.
  const knownReps = new Set(db.prepare('SELECT zoho_salesperson_id AS id FROM salespersons').all().map((r) => r.id));
  const knownBrands = new Set(db.prepare('SELECT id FROM brands').all().map((b) => b.id));
  for (const cell of cells) {
    if (!knownReps.has(cell.salesperson_id)) {
      const err = new Error(`unknown salesperson_id ${cell.salesperson_id}`);
      err.status = 400;
      throw err;
    }
    if (!attribution.isRepVisible(cell.salesperson_id)) {
      const err = new Error(
        `salesperson ${cell.salesperson_id} is hidden by the current rep visibility scope — ` +
          'make them visible on the Reps page before setting a target'
      );
      err.status = 400;
      throw err;
    }
    if (cell.brand_id !== null && cell.brand_id !== undefined && !knownBrands.has(Number(cell.brand_id))) {
      const err = new Error(`unknown brand_id ${cell.brand_id}`);
      err.status = 400;
      throw err;
    }
  }
  const upsert = db.prepare(
    `INSERT INTO targets (salesperson_id, month, brand_id, target_amount, note)
     VALUES (@salesperson_id, @month, @brand_id, @target_amount, @note)
     ON CONFLICT(salesperson_id, month, IFNULL(brand_id, 0)) DO UPDATE SET
       target_amount = excluded.target_amount,
       note = excluded.note,
       updated_at = datetime('now')`
  );
  const remove = db.prepare(
    `DELETE FROM targets WHERE salesperson_id = @salesperson_id AND month = @month
       AND IFNULL(brand_id, 0) = IFNULL(@brand_id, 0)`
  );

  const stats = { upserted: 0, removed: 0 };
  db.transaction(() => {
    for (const cell of cells) {
      const payload = {
        salesperson_id: cell.salesperson_id,
        month: m,
        brand_id: cell.brand_id ?? null,
        target_amount: Number(cell.target_amount) || 0,
        note: cell.note ?? null,
      };
      // a zero/blank cell means "no target" — keep the grid clean
      if (!payload.target_amount) {
        const info = remove.run(payload);
        stats.removed += info.changes;
      } else {
        upsert.run(payload);
        stats.upserted += 1;
      }
    }
  })();

  return { ...stats, ...getTargets(m) };
}

module.exports = {
  PRODUCT_SORTS,
  PRODUCT_SORT_KEYS,
  likePattern,
  currentMonth,
  shiftMonth,
  monthList,
  lineBrandCte,
  pendingLineItemInvoices,
  summary,
  mom,
  products,
  brandRollup,
  mtdBrands,
  getTargets,
  upsertTargets,
};
