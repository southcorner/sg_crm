'use strict';

/**
 * Dormant customers — "has bought before, but not lately".
 *
 * A customer is dormant when it has at least one non-void invoice and its most
 * recent one is OLDER than `today − N months`, N coming from the `dormant_months`
 * setting (overridable per request). Strictly older: a customer whose last
 * invoice is exactly N months old is still inside the window and is NOT dormant
 * — one more day and it is.
 *
 * The last-invoice date is recomputed from `invoices` rather than read off the
 * denormalized `customers.last_invoice_date`, so a stale sync can never mark a
 * live customer dormant (and voiding an invoice takes effect immediately).
 *
 * Inactive customers (Zoho `status <> 'active'`) are excluded by default —
 * nobody wants to chase an account that was closed on purpose — but the caller
 * can ask for them with `includeInactive`.
 *
 * Reused by the phase-4 reminder engine's "dormant" digest section.
 */

const { getDb } = require('../db/connection');
const config = require('../config');
const { customerRepIdExpr, todayIso } = require('./attribution');

const DEFAULT_MONTHS = 3;
const MAX_MONTHS = 120;

/** The configured dormancy window, clamped to something sane. */
function dormantMonths(override) {
  const raw = override === undefined || override === null || override === '' ? config.getSetting('dormant_months', DEFAULT_MONTHS) : override;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MONTHS;
  return Math.min(n, MAX_MONTHS);
}

/**
 * The cut-off date: last_invoice_date < threshold ⇒ dormant. Month arithmetic
 * is done by SQLite so it matches every other date filter in the app (and so
 * "31 Jan − 1 month" normalizes the same way everywhere).
 */
function thresholdDate(months, { now = new Date() } = {}) {
  return getDb().prepare("SELECT date(?, ?) AS d").get(todayIso(now), `-${months} months`).d;
}

/** Whole months between two YYYY-MM-DD dates (partial months don't count). */
function monthsBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const [fy, fm, fd] = String(fromIso).slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = String(toIso).slice(0, 10).split('-').map(Number);
  if (!fy || !ty) return null;
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return Math.max(0, months);
}

/**
 * The dormant list.
 *
 * @param {object}  opts
 * @param {number}  [opts.months]           window override; falls back to the setting
 * @param {boolean} [opts.includeInactive]  keep Zoho-inactive customers in the list
 * @param {Date}    [opts.now]              injectable "today" (tests)
 * @param {number}  [opts.limit]
 */
function listDormant({ months: monthsOverride, includeInactive = false, now = new Date(), limit = 1000 } = {}) {
  const db = getDb();
  const months = dormantMonths(monthsOverride);
  const today = todayIso(now);
  const threshold = thresholdDate(months, { now });
  const month = today.slice(0, 7);

  const rows = db
    .prepare(
      `SELECT x.*, s.name AS effective_rep_name
         FROM (
           SELECT c.zoho_contact_id AS id,
                  c.contact_name,
                  c.company_name,
                  c.status,
                  c.mobile,
                  c.email,
                  c.place_of_contact,
                  c.outstanding_receivable,
                  li.last_invoice_date,
                  li.first_invoice_date,
                  li.invoice_count,
                  li.lifetime_value,
                  ${customerRepIdExpr('c')} AS effective_rep_id,
                  (SELECT f.id FROM focus_plans f
                    WHERE f.customer_id = c.zoho_contact_id AND f.month = @month) AS focus_id
             FROM customers c
             JOIN (SELECT customer_id,
                          MAX(invoice_date) AS last_invoice_date,
                          MIN(invoice_date) AS first_invoice_date,
                          COUNT(*) AS invoice_count,
                          COALESCE(SUM(total), 0) AS lifetime_value
                     FROM invoices
                    WHERE status <> 'void' AND invoice_date IS NOT NULL
                    GROUP BY customer_id) li
               ON li.customer_id = c.zoho_contact_id
            WHERE li.last_invoice_date < @threshold
              ${includeInactive ? '' : "AND c.status = 'active'"}
         ) x
         LEFT JOIN salespersons s ON s.zoho_salesperson_id = x.effective_rep_id
        ORDER BY x.outstanding_receivable DESC, x.last_invoice_date ASC, x.contact_name ASC
        LIMIT @limit`
    )
    .all({ threshold, month, limit });

  return {
    months,
    threshold,
    today,
    includeInactive,
    total: rows.length,
    outstandingTotal: Math.round(rows.reduce((s, r) => s + (r.outstanding_receivable || 0), 0) * 100) / 100,
    rows: rows.map((r) => ({
      ...r,
      months_dormant: monthsBetween(r.last_invoice_date, today),
      in_focus: r.focus_id !== null,
    })),
  };
}

/** Just the count — the dashboard tile doesn't need the rows. */
function dormantCount({ months: monthsOverride, includeInactive = false, now = new Date() } = {}) {
  const db = getDb();
  const months = dormantMonths(monthsOverride);
  const threshold = thresholdDate(months, { now });

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(c.outstanding_receivable), 0) AS outstanding
         FROM customers c
         JOIN (SELECT customer_id, MAX(invoice_date) AS last_invoice_date
                 FROM invoices
                WHERE status <> 'void' AND invoice_date IS NOT NULL
                GROUP BY customer_id) li
           ON li.customer_id = c.zoho_contact_id
        WHERE li.last_invoice_date < @threshold
          ${includeInactive ? '' : "AND c.status = 'active'"}`
    )
    .get({ threshold });

  return { months, threshold, count: Number(row.n || 0), outstanding: row.outstanding || 0 };
}

module.exports = {
  DEFAULT_MONTHS,
  MAX_MONTHS,
  dormantMonths,
  thresholdDate,
  monthsBetween,
  listDormant,
  dormantCount,
};
