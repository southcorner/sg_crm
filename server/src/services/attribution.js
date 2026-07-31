'use strict';

/**
 * Effective-rep attribution.
 *
 * The Zoho salesperson on an invoice is never mutated. Instead the "effective
 * rep" is resolved at query time:
 *
 *   1. the active `customer_rep_assignments` row whose
 *      [effective_from, effective_to) range contains the invoice date
 *      (latest effective_from wins if ranges overlap),
 *   2. otherwise the invoice's own salesperson — matched by salesperson_id
 *      first, by salesperson_name second,
 *   3. otherwise NULL ("unattributed"), which the UI surfaces rather than
 *      guessing.
 *
 * `effectiveRepExpr()` / `invoiceRepCte()` are the reusable SQL used by every
 * performance rollup so the two can never drift apart.
 */

const { getDb } = require('../db/connection');

const ALL_HISTORY_FROM = '0000-01-01';
const MODES = ['from_today', 'all_history'];

/** Local (not UTC) YYYY-MM-DD — the admin thinks in the server's timezone. */
function todayIso(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

/**
 * SQL expression yielding the effective salesperson id for an invoice row
 * aliased as `alias` (needs alias.customer_id, .invoice_date, .salesperson_id,
 * .salesperson_name in scope).
 */
function effectiveRepExpr(alias = 'i') {
  return `COALESCE(
    (SELECT a.salesperson_id
       FROM customer_rep_assignments a
      WHERE a.customer_id = ${alias}.customer_id
        AND a.superseded_at IS NULL
        AND a.effective_from <= ${alias}.invoice_date
        AND (a.effective_to IS NULL OR ${alias}.invoice_date < a.effective_to)
      ORDER BY a.effective_from DESC, a.id DESC
      LIMIT 1),
    (SELECT s.zoho_salesperson_id FROM salespersons s
      WHERE s.zoho_salesperson_id = ${alias}.salesperson_id),
    (SELECT s.zoho_salesperson_id FROM salespersons s
      WHERE ${alias}.salesperson_name IS NOT NULL AND TRIM(${alias}.salesperson_name) <> ''
        AND LOWER(s.name) = LOWER(TRIM(${alias}.salesperson_name))
      LIMIT 1)
  )`;
}

/**
 * A CTE body (without the leading `WITH`) exposing one row per non-void invoice
 * with its effective rep. `where` is extra SQL ANDed onto the invoice filter.
 */
function invoiceRepCte({ where = '', name = 'invoice_rep' } = {}) {
  return `${name} AS (
    SELECT i.zoho_invoice_id AS invoice_id,
           i.customer_id,
           i.customer_name,
           i.invoice_number,
           i.invoice_date,
           substr(i.invoice_date, 1, 7) AS month,
           i.total,
           i.balance,
           i.status,
           ${effectiveRepExpr('i')} AS rep_id
      FROM invoices i
     WHERE i.status <> 'void'
       AND i.invoice_date IS NOT NULL
       ${where ? `AND ${where}` : ''}
  )`;
}

/** Effective rep *name* for a customer row aliased `alias`, as of today. */
function customerRepNameExpr(alias = 'c') {
  return `COALESCE(
    (SELECT s.name FROM customer_rep_assignments a
       JOIN salespersons s ON s.zoho_salesperson_id = a.salesperson_id
      WHERE a.customer_id = ${alias}.zoho_contact_id
        AND a.superseded_at IS NULL
        AND a.effective_from <= date('now', 'localtime')
        AND (a.effective_to IS NULL OR date('now', 'localtime') < a.effective_to)
      ORDER BY a.effective_from DESC, a.id DESC
      LIMIT 1),
    (SELECT COALESCE(s.name, i.salesperson_name)
       FROM invoices i
       LEFT JOIN salespersons s ON s.zoho_salesperson_id = i.salesperson_id
      WHERE i.customer_id = ${alias}.zoho_contact_id AND i.status <> 'void'
      ORDER BY i.invoice_date DESC, i.zoho_invoice_id DESC
      LIMIT 1)
  )`;
}

/** 'assigned' when an explicit assignment covers today, else 'invoice'. */
function customerRepSourceExpr(alias = 'c') {
  return `CASE WHEN EXISTS (
      SELECT 1 FROM customer_rep_assignments a
       WHERE a.customer_id = ${alias}.zoho_contact_id
         AND a.superseded_at IS NULL
         AND a.effective_from <= date('now', 'localtime')
         AND (a.effective_to IS NULL OR date('now', 'localtime') < a.effective_to)
    ) THEN 'assigned' ELSE 'invoice' END`;
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

const ASSIGNMENT_SELECT = `
  SELECT a.id, a.customer_id, a.salesperson_id, a.effective_from, a.effective_to,
         a.note, a.mode, a.superseded_at, a.superseded_by, a.closed_by,
         a.created_at, a.updated_at,
         s.name AS salesperson_name,
         (a.superseded_at IS NULL) AS is_active
    FROM customer_rep_assignments a
    LEFT JOIN salespersons s ON s.zoho_salesperson_id = a.salesperson_id`;

function listAssignments(customerId) {
  return getDb()
    .prepare(`${ASSIGNMENT_SELECT} WHERE a.customer_id = ? ORDER BY a.created_at DESC, a.id DESC`)
    .all(customerId)
    .map((r) => ({
      ...r,
      is_active: Boolean(r.is_active),
      all_history: r.effective_from === ALL_HISTORY_FROM,
    }));
}

/** Who is on this customer today, and why. */
function currentRep(customerId, { now = new Date() } = {}) {
  const db = getDb();
  const today = todayIso(now);

  const assignment = db
    .prepare(
      `${ASSIGNMENT_SELECT}
        WHERE a.customer_id = @customer_id
          AND a.superseded_at IS NULL
          AND a.effective_from <= @today
          AND (a.effective_to IS NULL OR @today < a.effective_to)
        ORDER BY a.effective_from DESC, a.id DESC
        LIMIT 1`
    )
    .get({ customer_id: customerId, today });

  if (assignment) {
    return {
      salesperson_id: assignment.salesperson_id,
      salesperson_name: assignment.salesperson_name,
      source: 'assignment',
      since: assignment.effective_from === ALL_HISTORY_FROM ? null : assignment.effective_from,
      all_history: assignment.effective_from === ALL_HISTORY_FROM,
      assignment_id: assignment.id,
      note: assignment.note,
    };
  }

  const fromInvoice = db
    .prepare(
      `SELECT i.salesperson_id, COALESCE(s.name, i.salesperson_name) AS salesperson_name, i.invoice_date
         FROM invoices i
         LEFT JOIN salespersons s ON s.zoho_salesperson_id = i.salesperson_id
        WHERE i.customer_id = ? AND i.status <> 'void'
        ORDER BY i.invoice_date DESC, i.zoho_invoice_id DESC
        LIMIT 1`
    )
    .get(customerId);

  if (fromInvoice && (fromInvoice.salesperson_id || fromInvoice.salesperson_name)) {
    return {
      salesperson_id: fromInvoice.salesperson_id || null,
      salesperson_name: fromInvoice.salesperson_name || null,
      source: 'invoice',
      since: null,
      all_history: false,
      assignment_id: null,
      note: null,
    };
  }

  return { salesperson_id: null, salesperson_name: null, source: 'none', since: null, all_history: false };
}

/** The effective rep for one invoice (used by invoice detail / tests). */
function invoiceRep(invoiceId) {
  return getDb()
    .prepare(
      `SELECT r.invoice_id, r.rep_id, s.name AS rep_name
         FROM (SELECT i.zoho_invoice_id AS invoice_id, ${effectiveRepExpr('i')} AS rep_id
                 FROM invoices i WHERE i.zoho_invoice_id = ?) r
         LEFT JOIN salespersons s ON s.zoho_salesperson_id = r.rep_id`
    )
    .get(invoiceId);
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Reassign a customer to a rep.
 *
 *   mode='from_today'   closes the currently-open assignment at today's date
 *                       and opens a new one from today. History stays with
 *                       whoever it was attributed to.
 *   mode='all_history'  opens a row at '0000-01-01' and marks every previously
 *                       active row superseded, so EVERY invoice — past and
 *                       future — re-attributes to the new rep.
 *
 * Both are reversible: `deleteAssignment(id)` restores whatever the row closed
 * or superseded.
 */
function assignCustomer(customerId, salespersonId, mode, note = null, { now = new Date() } = {}) {
  const db = getDb();
  if (!MODES.includes(mode)) throw httpError(400, `mode must be one of ${MODES.join(' | ')}`);

  const customer = db.prepare('SELECT zoho_contact_id FROM customers WHERE zoho_contact_id = ?').get(customerId);
  if (!customer) throw httpError(404, 'customer not found');
  const rep = db.prepare('SELECT zoho_salesperson_id FROM salespersons WHERE zoho_salesperson_id = ?').get(salespersonId);
  if (!rep) throw httpError(404, 'salesperson not found');

  const today = todayIso(now);
  const effectiveFrom = mode === 'all_history' ? ALL_HISTORY_FROM : today;

  const insert = db.prepare(
    `INSERT INTO customer_rep_assignments (customer_id, salesperson_id, effective_from, effective_to, note, mode)
     VALUES (?, ?, ?, NULL, ?, ?)`
  );
  const closeOpen = db.prepare(
    `UPDATE customer_rep_assignments
        SET effective_to = ?, closed_by = ?, updated_at = datetime('now')
      WHERE customer_id = ? AND id <> ? AND superseded_at IS NULL AND effective_to IS NULL`
  );
  const supersede = db.prepare(
    `UPDATE customer_rep_assignments
        SET superseded_at = datetime('now'), superseded_by = ?, updated_at = datetime('now')
      WHERE customer_id = ? AND id <> ? AND superseded_at IS NULL`
  );

  const id = db.transaction(() => {
    const info = insert.run(customerId, salespersonId, effectiveFrom, note, mode);
    const newId = Number(info.lastInsertRowid);
    if (mode === 'all_history') supersede.run(newId, customerId, newId);
    else closeOpen.run(today, newId, customerId, newId);
    return newId;
  })();

  return {
    assignment: getDb().prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).get(id),
    assignments: listAssignments(customerId),
    current: currentRep(customerId, { now }),
  };
}

/** Undo a reassignment: restores rows it closed / superseded, then removes it. */
function deleteAssignment(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM customer_rep_assignments WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'assignment not found');

  db.transaction(() => {
    db.prepare(
      `UPDATE customer_rep_assignments
          SET superseded_at = NULL, superseded_by = NULL, updated_at = datetime('now')
        WHERE superseded_by = ?`
    ).run(id);
    db.prepare(
      `UPDATE customer_rep_assignments
          SET effective_to = NULL, closed_by = NULL, updated_at = datetime('now')
        WHERE closed_by = ?`
    ).run(id);
    db.prepare('DELETE FROM customer_rep_assignments WHERE id = ?').run(id);
  })();

  return { deleted: id, assignments: listAssignments(row.customer_id), current: currentRep(row.customer_id) };
}

// ---------------------------------------------------------------------------
// reps
// ---------------------------------------------------------------------------

function listReps({ includeInactive = true } = {}) {
  const db = getDb();
  return db
    .prepare(
      `SELECT s.zoho_salesperson_id AS id, s.name, s.email, s.crm_email, s.whatsapp_number,
              s.notify_email, s.notify_whatsapp, s.is_active, s.notes, s.synced_at,
              (SELECT COUNT(*) FROM customer_rep_assignments a
                WHERE a.salesperson_id = s.zoho_salesperson_id AND a.superseded_at IS NULL) AS assignment_count
         FROM salespersons s
        ${includeInactive ? '' : 'WHERE s.is_active = 1'}
        ORDER BY s.is_active DESC, s.name ASC`
    )
    .all()
    .map((r) => ({
      ...r,
      notify_email: Boolean(r.notify_email),
      notify_whatsapp: Boolean(r.notify_whatsapp),
      is_active: Boolean(r.is_active),
    }));
}

/** Update the CRM-owned columns only — sync never touches these. */
function updateRep(id, patch) {
  const db = getDb();
  const rep = db.prepare('SELECT * FROM salespersons WHERE zoho_salesperson_id = ?').get(id);
  if (!rep) throw httpError(404, 'salesperson not found');

  const next = {
    crm_email: patch.crm_email !== undefined ? patch.crm_email || null : rep.crm_email,
    whatsapp_number:
      patch.whatsapp_number !== undefined
        ? (patch.whatsapp_number || '').replace(/\D/g, '') || null
        : rep.whatsapp_number,
    notify_email: patch.notify_email !== undefined ? (patch.notify_email ? 1 : 0) : rep.notify_email,
    notify_whatsapp: patch.notify_whatsapp !== undefined ? (patch.notify_whatsapp ? 1 : 0) : rep.notify_whatsapp,
    is_active: patch.is_active !== undefined ? (patch.is_active ? 1 : 0) : rep.is_active,
    notes: patch.notes !== undefined ? patch.notes || null : rep.notes,
  };

  db.prepare(
    `UPDATE salespersons SET crm_email = @crm_email, whatsapp_number = @whatsapp_number,
            notify_email = @notify_email, notify_whatsapp = @notify_whatsapp,
            is_active = @is_active, notes = @notes, updated_at = datetime('now')
      WHERE zoho_salesperson_id = @id`
  ).run({ ...next, id });

  return listReps().find((r) => r.id === id);
}

module.exports = {
  ALL_HISTORY_FROM,
  MODES,
  todayIso,
  effectiveRepExpr,
  invoiceRepCte,
  customerRepNameExpr,
  customerRepSourceExpr,
  listAssignments,
  currentRep,
  invoiceRep,
  assignCustomer,
  deleteAssignment,
  listReps,
  updateRep,
};
