'use strict';

/**
 * Monthly focus plans — "these are the customers to push this month".
 *
 * One row per (month, customer): the UNIQUE index in the schema is the source
 * of truth, and a duplicate insert is turned into a friendly 409 rather than a
 * raw SQLITE_CONSTRAINT.
 *
 * The rep on a plan row defaults to the customer's *effective* rep at the time
 * the row is created (services/attribution.js), so the phase-4 digest routes the
 * item to whoever actually owns the account — but it is stored, not resolved on
 * read, so a mid-month reassignment doesn't quietly move someone's plan out from
 * under them. It can always be overridden per row.
 */

const { getDb } = require('../db/connection');
const attribution = require('./attribution');
const { customerRepIdExpr, currentRep, todayIso } = attribution;

const STATUSES = ['open', 'done', 'dropped'];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function currentMonth(now = new Date()) {
  return todayIso(now).slice(0, 7);
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/**
 * Built per call, not once at module load: the global rep visibility scope can
 * change between requests. A plan row for a hidden rep's customer is hidden,
 * even when the row itself pins a visible rep.
 */
function selectSql() {
  const scope = attribution.customerScopeFilter('c');
  return `
  SELECT x.*, s.name AS rep_name
    FROM (
      SELECT f.id, f.month, f.customer_id, f.note, f.status, f.created_at, f.updated_at,
             c.contact_name AS customer_name,
             c.company_name,
             c.mobile,
             c.status AS customer_status,
             c.outstanding_receivable,
             c.last_invoice_date,
             c.invoice_count,
             COALESCE(f.salesperson_id, ${customerRepIdExpr('c')}) AS salesperson_id,
             (f.salesperson_id IS NOT NULL) AS rep_pinned
        FROM focus_plans f
        JOIN customers c ON c.zoho_contact_id = f.customer_id
       WHERE ${scope.sql}
    ) x
    LEFT JOIN salespersons s ON s.zoho_salesperson_id = x.salesperson_id`;
}

function getFocus(id) {
  const scope = attribution.customerScopeFilter('c');
  const row = getDb()
    .prepare(`${selectSql()} WHERE x.id = @id`)
    .get({ id: Number(id), ...scope.params });
  return row ? { ...row, rep_pinned: Boolean(row.rep_pinned) } : null;
}

/** Every plan row for a month, plus the open/done tallies the header shows. */
function listFocus(month, { now = new Date() } = {}) {
  const m = month || currentMonth(now);
  const scope = attribution.customerScopeFilter('c');
  const rows = getDb()
    .prepare(
      `${selectSql()} WHERE x.month = @month
        ORDER BY x.status ASC, x.outstanding_receivable DESC, x.customer_name ASC`
    )
    .all({ month: m, ...scope.params })
    .map((r) => ({ ...r, rep_pinned: Boolean(r.rep_pinned) }));

  const counts = { total: rows.length, open: 0, done: 0, dropped: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

  return {
    month: m,
    rows,
    counts,
    outstandingTotal: Math.round(rows.reduce((s, r) => s + (r.outstanding_receivable || 0), 0) * 100) / 100,
  };
}

/** Dashboard tile: open items in the given (default: current) month. */
function openFocusCount(month, { now = new Date() } = {}) {
  const m = month || currentMonth(now);
  const scope = attribution.customerIdScopeFilter('f.customer_id');
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS open,
              (SELECT COUNT(*) FROM focus_plans f WHERE f.month = @month AND ${scope.sql}) AS total
         FROM focus_plans f
        WHERE f.month = @month AND f.status = 'open' AND ${scope.sql}`
    )
    .get({ month: m, ...scope.params });
  return { month: m, open: Number(row.open || 0), total: Number(row.total || 0) };
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

/** The rep a new plan row is stamped with — only ever a real salespersons row. */
function defaultRep(customerId) {
  const current = currentRep(customerId);
  if (!current.salesperson_id) return null;
  const known = getDb()
    .prepare('SELECT zoho_salesperson_id FROM salespersons WHERE zoho_salesperson_id = ?')
    .get(current.salesperson_id);
  return known ? known.zoho_salesperson_id : null;
}

function createFocus({ month, customer_id: customerId, salesperson_id: salespersonId, note = null, status = 'open' }, { now = new Date() } = {}) {
  const db = getDb();
  const m = month || currentMonth(now);

  const customer = db.prepare('SELECT zoho_contact_id FROM customers WHERE zoho_contact_id = ?').get(customerId);
  if (!customer || !attribution.isCustomerVisible(customerId)) throw httpError(404, 'customer not found');

  let rep = salespersonId === undefined || salespersonId === null || salespersonId === '' ? defaultRep(customerId) : salespersonId;
  if (rep) {
    const known = db.prepare('SELECT zoho_salesperson_id FROM salespersons WHERE zoho_salesperson_id = ?').get(rep);
    if (!known) throw httpError(404, 'salesperson not found');
  } else {
    rep = null;
  }

  let info;
  try {
    info = db
      .prepare('INSERT INTO focus_plans (month, customer_id, salesperson_id, note, status) VALUES (?, ?, ?, ?, ?)')
      .run(m, customerId, rep, note || null, status);
  } catch (err) {
    if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
      const existing = db.prepare('SELECT id FROM focus_plans WHERE month = ? AND customer_id = ?').get(m, customerId);
      if (existing) {
        const conflict = httpError(409, 'that customer is already on the focus plan for this month');
        conflict.focus_id = existing.id;
        throw conflict;
      }
    }
    throw err;
  }

  return getFocus(Number(info.lastInsertRowid));
}

function updateFocus(id, patch) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM focus_plans WHERE id = ?').get(Number(id));
  if (!existing || !attribution.isCustomerVisible(existing.customer_id)) {
    throw httpError(404, 'focus item not found');
  }

  const next = {
    note: patch.note !== undefined ? patch.note || null : existing.note,
    status: patch.status !== undefined ? patch.status : existing.status,
    salesperson_id:
      patch.salesperson_id !== undefined ? patch.salesperson_id || null : existing.salesperson_id,
  };
  if (!STATUSES.includes(next.status)) throw httpError(400, `status must be one of ${STATUSES.join(' | ')}`);
  if (next.salesperson_id) {
    const known = db
      .prepare('SELECT zoho_salesperson_id FROM salespersons WHERE zoho_salesperson_id = ?')
      .get(next.salesperson_id);
    if (!known) throw httpError(404, 'salesperson not found');
  }

  db.prepare(
    `UPDATE focus_plans SET note = @note, status = @status, salesperson_id = @salesperson_id,
            updated_at = datetime('now')
      WHERE id = @id`
  ).run({ ...next, id: Number(id) });

  return getFocus(id);
}

function deleteFocus(id) {
  const existing = getDb().prepare('SELECT customer_id FROM focus_plans WHERE id = ?').get(Number(id));
  if (!existing || !attribution.isCustomerVisible(existing.customer_id)) {
    throw httpError(404, 'focus item not found');
  }
  const info = getDb().prepare('DELETE FROM focus_plans WHERE id = ?').run(Number(id));
  if (!info.changes) throw httpError(404, 'focus item not found');
  return { deleted: Number(id) };
}

module.exports = {
  STATUSES,
  currentMonth,
  listFocus,
  getFocus,
  openFocusCount,
  createFocus,
  updateFocus,
  deleteFocus,
};
