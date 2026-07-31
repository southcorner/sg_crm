'use strict';

/**
 * GET /api/customers      searchable / sortable / paginated list
 * GET /api/customers/:id  detail + that customer's invoices and payments
 */

const express = require('express');
const { z } = require('zod');
const { getDb } = require('../db/connection');
const { parsePaging, listResponse, route, sendError, likeTerm, sortColumn, sortDir } = require('./util');

const router = express.Router();

const SORTS = {
  name: 'c.contact_name',
  outstanding: 'c.outstanding_receivable',
  last_invoice_date: 'c.last_invoice_date',
  first_invoice_date: 'c.first_invoice_date',
  invoice_count: 'c.invoice_count',
  mobile: 'c.mobile',
};

const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  with_outstanding: z.enum(['0', '1']).optional(),
  sort: z.string().optional(),
  dir: z.string().optional(),
});

router.get(
  '/',
  route((req, res) => {
    const parsed = listQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const q = parsed.data;
    const paging = parsePaging(req.query || {});
    const db = getDb();

    const where = [];
    const params = {};

    if (q.search) {
      where.push(
        `(c.contact_name LIKE @search ESCAPE '\\' OR c.company_name LIKE @search ESCAPE '\\'
          OR c.mobile LIKE @search ESCAPE '\\' OR c.phone LIKE @search ESCAPE '\\'
          OR c.email LIKE @search ESCAPE '\\')`
      );
      params.search = likeTerm(q.search);
    }
    if (q.status !== 'all') {
      where.push('c.status = @status');
      params.status = q.status;
    }
    if (q.with_outstanding === '1') where.push('c.outstanding_receivable > 0');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderCol = sortColumn(q.sort, SORTS, 'c.contact_name');
    const dir = sortDir(q.dir, orderCol === 'c.contact_name' ? 'ASC' : 'DESC');

    const total = db.prepare(`SELECT COUNT(*) AS n FROM customers c ${whereSql}`).get(params).n;
    const rows = db
      .prepare(
        `SELECT c.zoho_contact_id AS id, c.contact_name, c.company_name, c.email, c.phone,
                c.mobile, c.status, c.outstanding_receivable, c.unused_credits,
                c.first_invoice_date, c.last_invoice_date, c.invoice_count, c.payment_terms_label
           FROM customers c
           ${whereSql}
          ORDER BY ${orderCol} ${dir} NULLS LAST, c.contact_name ASC
          LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: paging.limit, offset: paging.offset });

    return res.json(listResponse(rows, total, paging));
  })
);

router.get(
  '/:id',
  route((req, res) => {
    const db = getDb();
    const id = String(req.params.id);

    const customer = db
      .prepare(
        `SELECT zoho_contact_id AS id, contact_name, company_name, email, phone, mobile,
                contact_type, status, gst_no, place_of_contact, currency_code, payment_terms,
                payment_terms_label, outstanding_receivable, unused_credits,
                billing_address_json, shipping_address_json, first_invoice_date,
                last_invoice_date, invoice_count, last_modified_time, synced_at
           FROM customers WHERE zoho_contact_id = ?`
      )
      .get(id);

    if (!customer) return res.status(404).json({ error: 'customer not found' });

    customer.billing_address = safeJson(customer.billing_address_json);
    customer.shipping_address = safeJson(customer.shipping_address_json);
    delete customer.billing_address_json;
    delete customer.shipping_address_json;

    const invoices = db
      .prepare(
        `SELECT zoho_invoice_id AS id, invoice_number, invoice_date, due_date, status,
                total, balance, salesperson_name, line_items_synced
           FROM invoices WHERE customer_id = ?
          ORDER BY invoice_date DESC, invoice_number DESC
          LIMIT 500`
      )
      .all(id);

    const payments = db
      .prepare(
        `SELECT zoho_payment_id AS id, payment_number, payment_date, amount, payment_mode,
                reference_number, unused_amount, applied_invoices_json
           FROM payments WHERE customer_id = ?
          ORDER BY payment_date DESC
          LIMIT 500`
      )
      .all(id)
      .map((p) => ({
        ...p,
        applied_invoices: safeJson(p.applied_invoices_json) || [],
        applied_invoices_json: undefined,
      }));

    const totals = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status <> 'void' THEN total ELSE 0 END), 0) AS invoiced_total,
           COALESCE(SUM(CASE WHEN status <> 'void' THEN balance ELSE 0 END), 0) AS open_balance,
           SUM(CASE WHEN status <> 'void' AND balance > 0 AND due_date < date('now') THEN 1 ELSE 0 END) AS overdue_count
         FROM invoices WHERE customer_id = ?`
      )
      .get(id);

    const paymentTotal = db
      .prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE customer_id = ?')
      .get(id).n;

    return res.json({
      customer,
      invoices,
      payments,
      totals: { ...totals, payments_total: paymentTotal },
    });
  })
);

function safeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = router;
