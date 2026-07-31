'use strict';

/**
 * Zoho Books → SQLite sync.
 *
 * Entities (list endpoints, paginated 200/page):
 *   salespersons  /salespersons      full refresh (tiny)
 *   items         /items             incremental
 *   customers     /contacts          incremental, contact_type=customer
 *   invoices      /invoices          incremental (list only — no line items)
 *   payments      /customerpayments  incremental
 *
 * Incremental strategy: each entity keeps a cursor in `sync_state`. The next run
 * asks Zoho for `last_modified_time >= cursor − 5 minutes` (IST, +0530) so a
 * record modified while the previous run was mid-flight is not missed. Rows are
 * upserted by their Zoho id and the whole raw payload is kept in `raw_json`.
 *
 * Invoice line items are a second pass: the list endpoint has none, so every
 * invoice needs its own GET /invoices/{id}. Those are drained oldest-first
 * inside the remaining daily API budget, and the pass is resumable — an invoice
 * is only marked `line_items_synced = 1` once its rows are committed.
 *
 * Only one sync may run at a time (in-process lock); a second request while a
 * run is in flight is reported back as skipped.
 */

const { getDb } = require('../db/connection');
const config = require('../config');
const logger = require('../logger');
const auth = require('./auth');
const { ZohoClient, BudgetExceededError } = require('./client');

const OVERLAP_MS = 5 * 60 * 1000; // 5-minute re-read window
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const PER_PAGE = 200;
const DEFAULT_LINE_ITEM_BATCH = 200;

// ---------------------------------------------------------------------------
// time helpers — Zoho India expects ISO-8601 with an explicit +0530 offset
// ---------------------------------------------------------------------------

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** Date → '2026-07-31T14:05:00+0530' */
function toZohoTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return (
    `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}` +
    `T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+0530`
  );
}

/** '2026-07-31T14:05:00+0530' (or +05:30, or a bare date) → Date | null */
function parseZohoTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  // normalise '+0530' → '+05:30' so Date.parse is spec-compliant everywhere
  const normalised = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(normalised);
  return Number.isNaN(t) ? null : new Date(t);
}

function laterOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// sync_state helpers
// ---------------------------------------------------------------------------

const SYNC_ENTITIES = ['salespersons', 'items', 'customers', 'invoices', 'payments'];
const ALL_SYNC_KEYS = [...SYNC_ENTITIES, 'invoice_details'];

function getSyncState(entity) {
  const row = getDb().prepare('SELECT * FROM sync_state WHERE entity = ?').get(entity);
  return (
    row || {
      entity,
      cursor: null,
      last_run_at: null,
      last_status: null,
      last_error: null,
      records_synced: 0,
      total_pending: 0,
    }
  );
}

function updateSyncState(entity, patch) {
  const current = getSyncState(entity);
  const next = { ...current, ...patch, entity };
  getDb()
    .prepare(
      `INSERT INTO sync_state
         (entity, cursor, last_run_at, last_status, last_error, records_synced, total_pending, updated_at)
       VALUES (@entity, @cursor, @last_run_at, @last_status, @last_error, @records_synced, @total_pending, datetime('now'))
       ON CONFLICT(entity) DO UPDATE SET
         cursor = excluded.cursor,
         last_run_at = excluded.last_run_at,
         last_status = excluded.last_status,
         last_error = excluded.last_error,
         records_synced = excluded.records_synced,
         total_pending = excluded.total_pending,
         updated_at = excluded.updated_at`
    )
    .run({
      entity: next.entity,
      cursor: next.cursor ?? null,
      last_run_at: next.last_run_at ?? null,
      last_status: next.last_status ?? null,
      last_error: next.last_error ?? null,
      records_synced: Number(next.records_synced || 0),
      total_pending: Number(next.total_pending || 0),
    });
  return next;
}

// ---------------------------------------------------------------------------
// row mappers + upserts
// ---------------------------------------------------------------------------

const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v) || 0);
const str = (v) => (v === undefined || v === null ? null : String(v));
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

function upsertCustomers(rows) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO customers (
      zoho_contact_id, contact_name, company_name, email, phone, mobile, contact_type,
      status, gst_no, place_of_contact, currency_code, payment_terms, payment_terms_label,
      outstanding_receivable, unused_credits, billing_address_json, shipping_address_json,
      zoho_salesperson_id, raw_json, last_modified_time, synced_at, updated_at
    ) VALUES (
      @id, @contact_name, @company_name, @email, @phone, @mobile, @contact_type,
      @status, @gst_no, @place_of_contact, @currency_code, @payment_terms, @payment_terms_label,
      @outstanding_receivable, @unused_credits, @billing_address_json, @shipping_address_json,
      @zoho_salesperson_id, @raw_json, @last_modified_time, datetime('now'), datetime('now')
    )
    ON CONFLICT(zoho_contact_id) DO UPDATE SET
      contact_name = excluded.contact_name,
      company_name = excluded.company_name,
      email = excluded.email,
      phone = excluded.phone,
      mobile = excluded.mobile,
      contact_type = excluded.contact_type,
      status = excluded.status,
      gst_no = excluded.gst_no,
      place_of_contact = excluded.place_of_contact,
      currency_code = excluded.currency_code,
      payment_terms = excluded.payment_terms,
      payment_terms_label = excluded.payment_terms_label,
      outstanding_receivable = excluded.outstanding_receivable,
      unused_credits = excluded.unused_credits,
      billing_address_json = excluded.billing_address_json,
      shipping_address_json = excluded.shipping_address_json,
      zoho_salesperson_id = COALESCE(excluded.zoho_salesperson_id, customers.zoho_salesperson_id),
      raw_json = excluded.raw_json,
      last_modified_time = excluded.last_modified_time,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at
  `);

  const run = db.transaction((list) => {
    for (const c of list) {
      stmt.run({
        id: String(c.contact_id),
        contact_name: str(c.contact_name) || '',
        company_name: str(c.company_name),
        email: str(c.email),
        phone: str(c.phone),
        mobile: str(c.mobile),
        contact_type: str(c.contact_type) || 'customer',
        status: str(c.status),
        gst_no: str(c.gst_no),
        place_of_contact: str(c.place_of_contact),
        currency_code: str(c.currency_code),
        payment_terms: c.payment_terms === undefined ? null : num(c.payment_terms),
        payment_terms_label: str(c.payment_terms_label),
        outstanding_receivable: num(
          c.outstanding_receivable_amount ?? c.outstanding_receivable ?? 0
        ),
        unused_credits: num(c.unused_credits_receivable_amount ?? c.unused_credits ?? 0),
        billing_address_json: json(c.billing_address),
        shipping_address_json: json(c.shipping_address),
        zoho_salesperson_id: str(c.salesperson_id) || null,
        raw_json: JSON.stringify(c),
        last_modified_time: str(c.last_modified_time),
      });
    }
  });
  run(rows);
  return rows.length;
}

/**
 * Invoices and payments carry a customer_id with a foreign key into `customers`.
 * A contact can legitimately be missing locally (created after the customers
 * cursor moved, or excluded by the contact_type filter), and one such row must
 * not fail the whole page. Insert a stub the next contacts sync will fill in.
 */
function ensureCustomerStub(id, name) {
  if (!id) return;
  getDb()
    .prepare(
      `INSERT INTO customers (zoho_contact_id, contact_name, contact_type)
       VALUES (?, ?, 'customer')
       ON CONFLICT(zoho_contact_id) DO NOTHING`
    )
    .run(String(id), name ? String(name) : '');
}

function upsertInvoices(rows) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO invoices (
      zoho_invoice_id, invoice_number, customer_id, customer_name, salesperson_id,
      salesperson_name, invoice_date, due_date, status, total, sub_total, balance,
      currency_code, reference_number, raw_json, last_modified_time, synced_at, updated_at
    ) VALUES (
      @id, @invoice_number, @customer_id, @customer_name, @salesperson_id,
      @salesperson_name, @invoice_date, @due_date, @status, @total, @sub_total, @balance,
      @currency_code, @reference_number, @raw_json, @last_modified_time, datetime('now'), datetime('now')
    )
    ON CONFLICT(zoho_invoice_id) DO UPDATE SET
      invoice_number = excluded.invoice_number,
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      salesperson_id = excluded.salesperson_id,
      salesperson_name = excluded.salesperson_name,
      invoice_date = excluded.invoice_date,
      due_date = excluded.due_date,
      status = excluded.status,
      total = excluded.total,
      sub_total = excluded.sub_total,
      balance = excluded.balance,
      currency_code = excluded.currency_code,
      reference_number = excluded.reference_number,
      raw_json = excluded.raw_json,
      last_modified_time = excluded.last_modified_time,
      -- an edited invoice may have different lines: queue it for the detail pass again
      line_items_synced = CASE
        WHEN invoices.last_modified_time IS NOT excluded.last_modified_time THEN 0
        ELSE invoices.line_items_synced END,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at
  `);

  const run = db.transaction((list) => {
    for (const inv of list) {
      ensureCustomerStub(inv.customer_id, inv.customer_name);
      stmt.run({
        id: String(inv.invoice_id),
        invoice_number: str(inv.invoice_number),
        customer_id: str(inv.customer_id),
        customer_name: str(inv.customer_name),
        salesperson_id: str(inv.salesperson_id) || null,
        salesperson_name: str(inv.salesperson_name),
        invoice_date: str(inv.date ?? inv.invoice_date),
        due_date: str(inv.due_date),
        status: str(inv.status),
        total: num(inv.total),
        sub_total: num(inv.sub_total ?? inv.total),
        balance: num(inv.balance),
        currency_code: str(inv.currency_code),
        reference_number: str(inv.reference_number),
        raw_json: JSON.stringify(inv),
        last_modified_time: str(inv.last_modified_time),
      });
    }
  });
  run(rows);
  return rows.length;
}

function upsertPayments(rows) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO payments (
      zoho_payment_id, payment_number, customer_id, customer_name, payment_date, amount,
      unused_amount, bank_charges, payment_mode, reference_number, description,
      applied_invoices_json, raw_json, last_modified_time, synced_at
    ) VALUES (
      @id, @payment_number, @customer_id, @customer_name, @payment_date, @amount,
      @unused_amount, @bank_charges, @payment_mode, @reference_number, @description,
      @applied_invoices_json, @raw_json, @last_modified_time, datetime('now')
    )
    ON CONFLICT(zoho_payment_id) DO UPDATE SET
      payment_number = excluded.payment_number,
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      payment_date = excluded.payment_date,
      amount = excluded.amount,
      unused_amount = excluded.unused_amount,
      bank_charges = excluded.bank_charges,
      payment_mode = excluded.payment_mode,
      reference_number = excluded.reference_number,
      description = excluded.description,
      applied_invoices_json = excluded.applied_invoices_json,
      raw_json = excluded.raw_json,
      last_modified_time = excluded.last_modified_time,
      synced_at = excluded.synced_at
  `);

  const run = db.transaction((list) => {
    for (const p of list) {
      ensureCustomerStub(p.customer_id, p.customer_name);
      stmt.run({
        id: String(p.payment_id),
        payment_number: str(p.payment_number),
        customer_id: str(p.customer_id),
        customer_name: str(p.customer_name),
        payment_date: str(p.date ?? p.payment_date),
        amount: num(p.amount),
        unused_amount: num(p.unused_amount),
        bank_charges: num(p.bank_charges),
        payment_mode: str(p.payment_mode),
        reference_number: str(p.reference_number),
        description: str(p.description),
        applied_invoices_json: json(p.invoices ?? p.applied_invoices ?? null),
        raw_json: JSON.stringify(p),
        last_modified_time: str(p.last_modified_time),
      });
    }
  });
  run(rows);
  return rows.length;
}

function upsertItems(rows) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO items (
      zoho_item_id, name, sku, description, category_id, category_name, unit, rate,
      status, product_type, custom_fields_json, custom_fields_synced, raw_json,
      last_modified_time, synced_at
    ) VALUES (
      @id, @name, @sku, @description, @category_id, @category_name, @unit, @rate,
      @status, @product_type, @custom_fields_json, @custom_fields_synced, @raw_json,
      @last_modified_time, datetime('now')
    )
    ON CONFLICT(zoho_item_id) DO UPDATE SET
      name = excluded.name,
      sku = excluded.sku,
      description = excluded.description,
      category_id = excluded.category_id,
      category_name = excluded.category_name,
      unit = excluded.unit,
      rate = excluded.rate,
      status = excluded.status,
      product_type = excluded.product_type,
      custom_fields_json = COALESCE(excluded.custom_fields_json, items.custom_fields_json),
      custom_fields_synced = MAX(excluded.custom_fields_synced, items.custom_fields_synced),
      raw_json = excluded.raw_json,
      last_modified_time = excluded.last_modified_time,
      synced_at = excluded.synced_at
  `);

  const run = db.transaction((list) => {
    for (const it of list) {
      const hasCustom = Array.isArray(it.custom_fields) && it.custom_fields.length > 0;
      stmt.run({
        id: String(it.item_id),
        name: str(it.name) || '',
        sku: str(it.sku),
        description: str(it.description),
        category_id: str(it.category_id),
        category_name: str(it.category_name),
        unit: str(it.unit),
        rate: num(it.rate),
        status: str(it.status),
        product_type: str(it.product_type),
        custom_fields_json: hasCustom ? JSON.stringify(it.custom_fields) : null,
        custom_fields_synced: hasCustom ? 1 : 0,
        raw_json: JSON.stringify(it),
        last_modified_time: str(it.last_modified_time),
      });
    }
  });
  run(rows);
  return rows.length;
}

/** Salespersons: Zoho columns only — crm_email / whatsapp_number / notify_* are CRM-owned. */
function upsertSalespersons(rows) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO salespersons (
      zoho_salesperson_id, name, email, is_active, raw_json, last_modified_time, synced_at, updated_at
    ) VALUES (
      @id, @name, @email, @is_active, @raw_json, @last_modified_time, datetime('now'), datetime('now')
    )
    ON CONFLICT(zoho_salesperson_id) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      is_active = excluded.is_active,
      raw_json = excluded.raw_json,
      last_modified_time = excluded.last_modified_time,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at
  `);

  const run = db.transaction((list) => {
    for (const sp of list) {
      stmt.run({
        id: String(sp.salesperson_id),
        name: str(sp.salesperson_name ?? sp.name) || '',
        email: str(sp.salesperson_email ?? sp.email),
        is_active: sp.status === 'inactive' || sp.is_active === false ? 0 : 1,
        raw_json: JSON.stringify(sp),
        last_modified_time: str(sp.last_modified_time),
      });
    }
  });
  run(rows);
  return rows.length;
}

const ENTITY_CONFIG = {
  salespersons: {
    path: '/salespersons',
    listKey: 'salespersons',
    upsert: upsertSalespersons,
    table: 'salespersons',
    fullRefresh: true, // small list, no cursor filtering
  },
  items: { path: '/items', listKey: 'items', upsert: upsertItems, table: 'items' },
  customers: {
    path: '/contacts',
    listKey: 'contacts',
    query: { contact_type: 'customer' },
    upsert: upsertCustomers,
    table: 'customers',
  },
  invoices: { path: '/invoices', listKey: 'invoices', upsert: upsertInvoices, table: 'invoices' },
  payments: {
    path: '/customerpayments',
    listKey: 'customerpayments',
    upsert: upsertPayments,
    table: 'payments',
  },
};

// ---------------------------------------------------------------------------
// client factory
// ---------------------------------------------------------------------------

function createClient() {
  return new ZohoClient({
    getToken: (opts) => auth.getAccessToken(opts),
    getOrgId: () => auth.getOrgId(),
  });
}

// ---------------------------------------------------------------------------
// per-entity list sync
// ---------------------------------------------------------------------------

/**
 * Pull one entity's list endpoint (incrementally when a cursor exists) and
 * upsert every page. Returns {entity, fetched, pages, cursor, mode}.
 */
async function syncEntity(entity, { client, now = () => new Date() } = {}) {
  const cfg = ENTITY_CONFIG[entity];
  if (!cfg) throw new Error(`unknown sync entity: ${entity}`);
  const api = client || createClient();

  const state = getSyncState(entity);
  const runStart = now();
  const query = { ...(cfg.query || {}) };

  let mode = 'full';
  if (!cfg.fullRefresh && state.cursor) {
    const cursorDate = parseZohoTime(state.cursor);
    if (cursorDate) {
      query.last_modified_time = toZohoTime(new Date(cursorDate.getTime() - OVERLAP_MS));
      mode = 'incremental';
    }
  }

  updateSyncState(entity, { last_status: 'running', last_error: null, last_run_at: nowIso() });

  let fetched = 0;
  let pages = 0;
  let maxModified = null;

  try {
    await api.paginate(cfg.path, {
      query,
      listKey: cfg.listKey,
      perPage: PER_PAGE,
      onPage: (batch) => {
        pages += 1;
        if (!batch.length) return;
        cfg.upsert(batch);
        fetched += batch.length;
        for (const row of batch) {
          const d = parseZohoTime(row.last_modified_time);
          if (d) maxModified = laterOf(maxModified, d);
        }
      },
    });
  } catch (err) {
    updateSyncState(entity, {
      last_status: err instanceof BudgetExceededError ? 'halted' : 'error',
      last_error: err.message,
      last_run_at: nowIso(),
      records_synced: fetched,
    });
    throw err;
  }

  const previousCursor = parseZohoTime(state.cursor);
  const nextCursorDate = laterOf(maxModified || runStart, previousCursor) || runStart;
  const cursor = toZohoTime(nextCursorDate);

  updateSyncState(entity, {
    cursor,
    last_status: 'ok',
    last_error: null,
    last_run_at: nowIso(),
    records_synced: fetched,
    total_pending: 0,
  });

  logger.info({ entity, fetched, pages, mode, cursor }, 'zoho entity synced');
  return { entity, fetched, pages, cursor, mode };
}

// ---------------------------------------------------------------------------
// invoice line-item second pass
// ---------------------------------------------------------------------------

function replaceLineItems(invoiceId, lineItems) {
  const db = getDb();
  const del = db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?');
  const ins = db.prepare(`
    INSERT INTO invoice_line_items (
      zoho_line_item_id, invoice_id, item_id, line_order, name, description, sku,
      quantity, unit, rate, discount_amount, item_total, raw_json, synced_at
    ) VALUES (
      @line_id, @invoice_id, @item_id, @line_order, @name, @description, @sku,
      @quantity, @unit, @rate, @discount_amount, @item_total, @raw_json, datetime('now')
    )
    ON CONFLICT(zoho_line_item_id) DO UPDATE SET
      invoice_id = excluded.invoice_id,
      item_id = excluded.item_id,
      line_order = excluded.line_order,
      name = excluded.name,
      description = excluded.description,
      sku = excluded.sku,
      quantity = excluded.quantity,
      unit = excluded.unit,
      rate = excluded.rate,
      discount_amount = excluded.discount_amount,
      item_total = excluded.item_total,
      raw_json = excluded.raw_json,
      synced_at = excluded.synced_at
  `);
  const mark = db.prepare(
    `UPDATE invoices SET line_items_synced = 1, line_items_synced_at = datetime('now') WHERE zoho_invoice_id = ?`
  );

  const tx = db.transaction((id, lines) => {
    del.run(id);
    lines.forEach((li, idx) => {
      ins.run({
        line_id: String(li.line_item_id ?? `${id}-${idx}`),
        invoice_id: id,
        item_id: str(li.item_id),
        line_order: idx,
        name: str(li.name),
        description: str(li.description),
        sku: str(li.sku),
        quantity: num(li.quantity),
        unit: str(li.unit),
        rate: num(li.rate),
        discount_amount: num(li.discount_amount ?? li.discount),
        item_total: num(li.item_total),
        raw_json: JSON.stringify(li),
      });
    });
    mark.run(id);
  });

  tx(invoiceId, lineItems || []);
}

function lineItemProgress() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN line_items_synced = 1 THEN 1 ELSE 0 END) AS synced
         FROM invoices`
    )
    .get();
  const total = Number(row.total || 0);
  const synced = Number(row.synced || 0);
  return { total, synced, pending: Math.max(0, total - synced) };
}

/**
 * Drain the `line_items_synced = 0` queue oldest-first, one GET /invoices/{id}
 * per invoice, stopping when the batch limit or the daily API budget runs out.
 * Resumable: each invoice is committed (rows + flag) in a single transaction.
 */
async function syncInvoiceLineItems({ client, limit = DEFAULT_LINE_ITEM_BATCH } = {}) {
  const api = client || createClient();
  const db = getDb();

  const budget = api.budgetStatus ? api.budgetStatus() : { remaining: limit };
  const take = Math.max(0, Math.min(limit, budget.remaining));
  const before = lineItemProgress();

  updateSyncState('invoice_details', {
    last_status: 'running',
    last_error: null,
    last_run_at: nowIso(),
    total_pending: before.pending,
  });

  if (take === 0) {
    updateSyncState('invoice_details', {
      last_status: before.pending > 0 ? 'halted' : 'ok',
      last_error: before.pending > 0 ? 'daily API budget exhausted' : null,
      last_run_at: nowIso(),
      total_pending: before.pending,
      records_synced: 0,
    });
    return { processed: 0, failed: 0, halted: before.pending > 0, ...before };
  }

  const pending = db
    .prepare(
      `SELECT zoho_invoice_id FROM invoices
        WHERE line_items_synced = 0
        ORDER BY invoice_date ASC, zoho_invoice_id ASC
        LIMIT ?`
    )
    .all(take);

  let processed = 0;
  let failed = 0;
  let halted = false;
  let lastError = null;

  for (const row of pending) {
    const id = row.zoho_invoice_id;
    try {
      const payload = await api.get(`/invoices/${id}`);
      const invoice = payload.invoice || {};
      replaceLineItems(id, invoice.line_items || []);
      processed += 1;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        halted = true;
        lastError = err.message;
        break;
      }
      failed += 1;
      lastError = err.message;
      logger.warn({ invoiceId: id, err: err.message }, 'invoice line-item fetch failed');
      // three consecutive-ish failures usually means auth/config is broken
      if (failed >= 3) break;
    }
  }

  const after = lineItemProgress();

  // the batch is clamped to the remaining budget, so we can run out without any
  // call ever throwing — report that as halted too, so the UI shows the banner.
  if (!halted && after.pending > 0) {
    const remaining = api.budgetStatus ? api.budgetStatus().remaining : null;
    if (remaining !== null && remaining <= 0) {
      halted = true;
      lastError = lastError || 'daily API budget exhausted';
    }
  }

  updateSyncState('invoice_details', {
    last_status: halted ? 'halted' : failed && !processed ? 'error' : 'ok',
    last_error: lastError,
    last_run_at: nowIso(),
    records_synced: processed,
    total_pending: after.pending,
  });

  logger.info({ processed, failed, halted, pending: after.pending }, 'invoice line-item pass done');
  return { processed, failed, halted, ...after };
}

// ---------------------------------------------------------------------------
// post-sync derivations
// ---------------------------------------------------------------------------

/** Recompute customers.first/last_invoice_date + invoice_count (voids excluded). */
function recomputeCustomerInvoiceDates() {
  const db = getDb();
  const info = db
    .prepare(
      `UPDATE customers SET
         first_invoice_date = (
           SELECT MIN(i.invoice_date) FROM invoices i
            WHERE i.customer_id = customers.zoho_contact_id AND i.status <> 'void'),
         last_invoice_date = (
           SELECT MAX(i.invoice_date) FROM invoices i
            WHERE i.customer_id = customers.zoho_contact_id AND i.status <> 'void'),
         invoice_count = (
           SELECT COUNT(*) FROM invoices i
            WHERE i.customer_id = customers.zoho_contact_id AND i.status <> 'void'),
         updated_at = datetime('now')`
    )
    .run();
  return info.changes;
}

// ---------------------------------------------------------------------------
// orchestration (serialized)
// ---------------------------------------------------------------------------

let currentRun = null; // Promise while a sync is in flight
let currentRunInfo = null;

function isRunning() {
  return Boolean(currentRun);
}

async function _runSync({ entities, client, lineItemLimit } = {}) {
  const api = client || createClient();
  const list = entities && entities.length ? entities : SYNC_ENTITIES;
  const listEntities = list.filter((e) => ENTITY_CONFIG[e]);
  const wantsLineItems = list.includes('invoices') || list.includes('invoice_details');
  const results = { startedAt: new Date().toISOString(), entities: {}, errors: [] };

  for (const entity of listEntities) {
    try {
      results.entities[entity] = await syncEntity(entity, { client: api });
    } catch (err) {
      results.entities[entity] = { entity, error: err.message };
      results.errors.push({ entity, error: err.message });
      if (err instanceof BudgetExceededError) {
        results.halted = true;
        results.haltReason = err.message;
        break;
      }
    }
  }

  if (!results.halted && wantsLineItems) {
    try {
      results.lineItems = await syncInvoiceLineItems({
        client: api,
        limit: lineItemLimit ?? Number(config.getSetting('zoho_line_item_batch', DEFAULT_LINE_ITEM_BATCH)),
      });
      if (results.lineItems.halted) {
        results.halted = true;
        results.haltReason = 'daily API budget exhausted during invoice line-item pass';
      }
    } catch (err) {
      results.errors.push({ entity: 'invoice_details', error: err.message });
      if (err instanceof BudgetExceededError) {
        results.halted = true;
        results.haltReason = err.message;
      }
    }
  }

  results.customersRecomputed = recomputeCustomerInvoiceDates();
  results.finishedAt = new Date().toISOString();
  results.ok = results.errors.length === 0;
  return results;
}

/**
 * Run a sync. Serialized: if one is already in flight this resolves immediately
 * with {skipped:true}. Awaiting the returned promise waits for completion.
 */
function runSync(options = {}) {
  if (currentRun) {
    return Promise.resolve({ skipped: true, reason: 'a sync is already running', ...currentRunInfo });
  }
  currentRunInfo = { startedAt: new Date().toISOString(), entities: options.entities || SYNC_ENTITIES };
  const p = _runSync(options)
    .catch((err) => {
      logger.error({ err: err.message }, 'sync run failed');
      return { ok: false, error: err.message, errors: [{ entity: 'sync', error: err.message }] };
    })
    .finally(() => {
      currentRun = null;
      currentRunInfo = null;
    });
  currentRun = p;
  return p;
}

/** Fire-and-forget wrapper for the HTTP route. */
function startSync(options = {}) {
  if (currentRun) return { started: false, running: true, ...currentRunInfo };
  const info = { started: true, running: true, startedAt: new Date().toISOString() };
  runSync(options).catch(() => {});
  return info;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

const COUNT_SQL = {
  customers: 'SELECT COUNT(*) AS n FROM customers',
  invoices: 'SELECT COUNT(*) AS n FROM invoices',
  payments: 'SELECT COUNT(*) AS n FROM payments',
  items: 'SELECT COUNT(*) AS n FROM items',
  salespersons: 'SELECT COUNT(*) AS n FROM salespersons',
  invoice_details: 'SELECT COUNT(*) AS n FROM invoice_line_items',
};

function getSyncStatus() {
  const db = getDb();
  const states = new Map(
    db
      .prepare('SELECT * FROM sync_state')
      .all()
      .map((r) => [r.entity, r])
  );

  const entities = ALL_SYNC_KEYS.map((entity) => {
    const s = states.get(entity) || {};
    const count = db.prepare(COUNT_SQL[entity]).get().n;
    return {
      entity,
      cursor: s.cursor || null,
      lastRunAt: s.last_run_at || null,
      lastStatus: s.last_status || null,
      lastError: s.last_error || null,
      recordsSynced: Number(s.records_synced || 0),
      rowCount: Number(count || 0),
    };
  });

  return {
    running: isRunning(),
    currentRun: currentRunInfo,
    connected: auth.isConnected(),
    entities,
    lineItems: lineItemProgress(),
    apiCalls: auth.getStatus().apiCalls,
  };
}

module.exports = {
  SYNC_ENTITIES,
  ALL_SYNC_KEYS,
  ENTITY_CONFIG,
  OVERLAP_MS,
  toZohoTime,
  parseZohoTime,
  createClient,
  getSyncState,
  updateSyncState,
  syncEntity,
  syncInvoiceLineItems,
  lineItemProgress,
  recomputeCustomerInvoiceDates,
  runSync,
  startSync,
  isRunning,
  getSyncStatus,
  upsertCustomers,
  upsertInvoices,
  upsertPayments,
  upsertItems,
  upsertSalespersons,
};
