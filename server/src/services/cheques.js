'use strict';

/**
 * Cheque register.
 *
 * Cheques are CRM-owned (Zoho Books has no concept of "a cheque sitting in the
 * drawer until the 12th"), so this is plain CRUD over the `cheques` table plus
 * one reusable query the reminder engine lives on:
 *
 *   chequesDueInDays(N) → every PENDING cheque whose deposit_date is exactly
 *   today + N. Exactly, not "within" — the phase-4 digest fires once per cheque,
 *   `cheque_lead_days` before it hits the bank, and a range would re-nag daily.
 *
 * The `received_date` field in the API is the `cheque_date` column (the date
 * written on the cheque); both names are accepted on write and returned on read.
 *
 * A cheque carries its own salesperson_id, snapshotted from the customer's
 * effective rep when it is created, so a later reassignment cannot silently
 * re-route a reminder mid-flight. The list still exposes the customer's live
 * effective rep alongside it.
 */

const { getDb } = require('../db/connection');
const config = require('../config');
const { customerRepIdExpr, todayIso, currentRep } = require('./attribution');

const STATUSES = ['pending', 'deposited', 'cleared', 'bounced'];
const PENDING = 'pending';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** YYYY-MM-DD ± n days, done in UTC so a DST hop can never shift the date. */
function addDays(iso, n) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

function leadDays() {
  const n = Math.trunc(Number(config.getSetting('cheque_lead_days', 3)));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 60) : 3;
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/**
 * One row per cheque with the customer's name/outstanding and the rep it is
 * routed to (its own salesperson, else the customer's effective rep today).
 */
function selectSql(where = '', order = 'ORDER BY x.deposit_date ASC, x.id DESC') {
  return `
    SELECT x.*, s.name AS rep_name
      FROM (
        SELECT ch.id,
               ch.customer_id,
               c.contact_name AS customer_name,
               c.company_name,
               c.mobile,
               c.outstanding_receivable,
               ch.amount,
               ch.cheque_number,
               ch.bank_name,
               ch.cheque_date,
               ch.cheque_date AS received_date,
               ch.deposit_date,
               ch.status,
               ch.zoho_payment_id,
               ch.note,
               ch.created_at,
               ch.updated_at,
               COALESCE(ch.salesperson_id, ${customerRepIdExpr('c')}) AS rep_id
          FROM cheques ch
          JOIN customers c ON c.zoho_contact_id = ch.customer_id
      ) x
      LEFT JOIN salespersons s ON s.zoho_salesperson_id = x.rep_id
      ${where}
      ${order}`;
}

function decorate(row, today) {
  if (!row) return row;
  const days = row.deposit_date
    ? Math.round((Date.parse(`${row.deposit_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)
    : null;
  return { ...row, days_to_deposit: days };
}

function getCheque(id, { now = new Date() } = {}) {
  const row = getDb().prepare(selectSql('WHERE x.id = @id', '')).get({ id: Number(id) });
  return decorate(row, todayIso(now));
}

/**
 * @param {object}   opts
 * @param {string[]} [opts.status]      one or more of STATUSES
 * @param {string}   [opts.dueBefore]   deposit_date <= this
 * @param {string}   [opts.dueAfter]    deposit_date >= this
 * @param {string}   [opts.customer]    customer id
 */
function listCheques({ status = [], dueBefore = null, dueAfter = null, customer = null, limit = 1000, now = new Date() } = {}) {
  const db = getDb();
  const today = todayIso(now);
  const where = [];
  const params = { limit };

  const statuses = (Array.isArray(status) ? status : [status]).filter((s) => STATUSES.includes(s));
  // safe to inline: every value is checked against the whitelist above
  if (statuses.length) where.push(`x.status IN (${statuses.map((s) => `'${s}'`).join(', ')})`);
  if (dueAfter) {
    where.push('x.deposit_date >= @dueAfter');
    params.dueAfter = dueAfter;
  }
  if (dueBefore) {
    where.push('x.deposit_date <= @dueBefore');
    params.dueBefore = dueBefore;
  }
  if (customer) {
    where.push('x.customer_id = @customer');
    params.customer = customer;
  }

  const rows = db
    .prepare(
      selectSql(
        where.length ? `WHERE ${where.join(' AND ')}` : '',
        'ORDER BY x.deposit_date ASC, x.id DESC LIMIT @limit'
      )
    )
    .all(params)
    .map((r) => decorate(r, today));

  const totals = { count: rows.length, amount: round2(rows.reduce((s, r) => s + (r.amount || 0), 0)) };
  const byStatus = {};
  for (const s of STATUSES) {
    const subset = rows.filter((r) => r.status === s);
    byStatus[s] = { count: subset.length, amount: round2(subset.reduce((sum, r) => sum + (r.amount || 0), 0)) };
  }

  return { rows, totals, byStatus, today, leadDays: leadDays(), statusCounts: statusCounts() };
}

/** Register-wide counts per status, independent of the current filter. */
function statusCounts() {
  const rows = getDb().prepare('SELECT status, COUNT(*) AS n FROM cheques GROUP BY status').all();
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/**
 * Every pending cheque depositing exactly `days` days from today.
 * The reminder engine calls this with `cheque_lead_days`.
 */
function chequesDueInDays(days = 0, { now = new Date() } = {}) {
  const today = todayIso(now);
  const target = addDays(today, days);
  return getDb()
    .prepare(selectSql("WHERE x.status = 'pending' AND x.deposit_date = @target", 'ORDER BY x.customer_name ASC, x.id ASC'))
    .all({ target })
    .map((r) => decorate(r, today));
}

/** Dashboard tile: pending volume + what lands in the next 7 days. */
function chequeSummary({ now = new Date(), horizonDays = 7 } = {}) {
  const db = getDb();
  const today = todayIso(now);
  const horizon = addDays(today, horizonDays);
  const lead = leadDays();

  const pending = db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM cheques WHERE status = 'pending'")
    .get();
  const next = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
         FROM cheques
        WHERE status = 'pending' AND deposit_date >= @today AND deposit_date <= @horizon`
    )
    .get({ today, horizon });
  const overdue = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
         FROM cheques
        WHERE status = 'pending' AND deposit_date IS NOT NULL AND deposit_date < @today`
    )
    .get({ today });

  return {
    pending: { count: Number(pending.count || 0), amount: pending.amount || 0 },
    next7: { count: Number(next.count || 0), amount: next.amount || 0, horizon, days: horizonDays },
    pastDue: { count: Number(overdue.count || 0), amount: overdue.amount || 0 },
    leadDays: lead,
    today,
  };
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

function requireCustomer(customerId) {
  const row = getDb().prepare('SELECT zoho_contact_id FROM customers WHERE zoho_contact_id = ?').get(customerId);
  if (!row) throw httpError(404, 'customer not found');
  return row;
}

/** The rep a new cheque is routed to — only ever a real salespersons row. */
function defaultRep(customerId) {
  const current = currentRep(customerId);
  if (!current.salesperson_id) return null;
  const known = getDb()
    .prepare('SELECT zoho_salesperson_id FROM salespersons WHERE zoho_salesperson_id = ?')
    .get(current.salesperson_id);
  return known ? known.zoho_salesperson_id : null;
}

function createCheque(input, { now = new Date() } = {}) {
  const db = getDb();
  requireCustomer(input.customer_id);

  const salespersonId =
    input.salesperson_id !== undefined && input.salesperson_id !== null
      ? input.salesperson_id
      : defaultRep(input.customer_id);

  const info = db
    .prepare(
      `INSERT INTO cheques (customer_id, salesperson_id, amount, cheque_number, bank_name,
                            cheque_date, deposit_date, status, zoho_payment_id, note)
       VALUES (@customer_id, @salesperson_id, @amount, @cheque_number, @bank_name,
               @cheque_date, @deposit_date, @status, @zoho_payment_id, @note)`
    )
    .run({
      customer_id: input.customer_id,
      salesperson_id: salespersonId,
      amount: Number(input.amount) || 0,
      cheque_number: input.cheque_number || null,
      bank_name: input.bank_name || null,
      cheque_date: input.received_date ?? input.cheque_date ?? null,
      deposit_date: input.deposit_date,
      status: input.status || PENDING,
      zoho_payment_id: input.zoho_payment_id || null,
      note: input.note || null,
    });

  return getCheque(Number(info.lastInsertRowid), { now });
}

const PATCHABLE = [
  'amount',
  'cheque_number',
  'bank_name',
  'cheque_date',
  'deposit_date',
  'status',
  'zoho_payment_id',
  'note',
  'salesperson_id',
  'customer_id',
];

function updateCheque(id, patch, { now = new Date() } = {}) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM cheques WHERE id = ?').get(Number(id));
  if (!existing) throw httpError(404, 'cheque not found');

  const next = { ...existing };
  const incoming = { ...patch };
  if (incoming.received_date !== undefined) incoming.cheque_date = incoming.received_date;
  for (const key of PATCHABLE) {
    if (incoming[key] === undefined) continue;
    next[key] = incoming[key] === '' ? null : incoming[key];
  }
  if (next.customer_id !== existing.customer_id) requireCustomer(next.customer_id);
  if (!STATUSES.includes(next.status)) throw httpError(400, `status must be one of ${STATUSES.join(' | ')}`);

  db.prepare(
    `UPDATE cheques SET customer_id = @customer_id, salesperson_id = @salesperson_id, amount = @amount,
            cheque_number = @cheque_number, bank_name = @bank_name, cheque_date = @cheque_date,
            deposit_date = @deposit_date, status = @status, zoho_payment_id = @zoho_payment_id,
            note = @note, updated_at = datetime('now')
      WHERE id = @id`
  ).run({
    id: Number(id),
    customer_id: next.customer_id,
    salesperson_id: next.salesperson_id ?? null,
    amount: Number(next.amount) || 0,
    cheque_number: next.cheque_number ?? null,
    bank_name: next.bank_name ?? null,
    cheque_date: next.cheque_date ?? null,
    deposit_date: next.deposit_date ?? null,
    status: next.status,
    zoho_payment_id: next.zoho_payment_id ?? null,
    note: next.note ?? null,
  });

  return getCheque(id, { now });
}

function deleteCheque(id) {
  const info = getDb().prepare('DELETE FROM cheques WHERE id = ?').run(Number(id));
  if (!info.changes) throw httpError(404, 'cheque not found');
  return { deleted: Number(id) };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = {
  STATUSES,
  PENDING,
  addDays,
  leadDays,
  listCheques,
  getCheque,
  statusCounts,
  chequesDueInDays,
  chequeSummary,
  createCheque,
  updateCheque,
  deleteCheque,
};
