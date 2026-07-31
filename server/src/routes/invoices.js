'use strict';

/**
 * GET /api/invoices      filterable list (customer, status, salesperson, dates)
 * GET /api/invoices/:id  detail + line items + payments applied to it
 */

const express = require('express');
const { z } = require('zod');
const { getDb } = require('../db/connection');
const { parsePaging, listResponse, route, sendError, likeTerm, sortColumn, sortDir } = require('./util');
const attribution = require('../services/attribution');

const router = express.Router();

const SORTS = {
  invoice_date: 'i.invoice_date',
  due_date: 'i.due_date',
  number: 'i.invoice_number',
  total: 'i.total',
  balance: 'i.balance',
  customer: 'i.customer_name',
  status: 'i.status',
};

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .optional();

const listQuerySchema = z.object({
  customer_id: z.string().trim().optional(),
  customer: z.string().trim().max(120).optional(),
  status: z.string().trim().optional(), // single or comma separated
  salesperson_id: z.string().trim().optional(),
  date_from: dateStr,
  date_to: dateStr,
  search: z.string().trim().max(120).optional(),
  overdue: z.enum(['0', '1']).optional(),
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

    if (q.customer_id) {
      where.push('i.customer_id = @customer_id');
      params.customer_id = q.customer_id;
    }
    if (q.customer) {
      where.push(`i.customer_name LIKE @customer ESCAPE '\\'`);
      params.customer = likeTerm(q.customer);
    }
    if (q.salesperson_id) {
      where.push('i.salesperson_id = @salesperson_id');
      params.salesperson_id = q.salesperson_id;
    }
    if (q.status) {
      const statuses = q.status
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (statuses.length) {
        const keys = statuses.map((s, idx) => {
          params[`status${idx}`] = s;
          return `@status${idx}`;
        });
        where.push(`i.status IN (${keys.join(', ')})`);
      }
    }
    if (q.date_from) {
      where.push('i.invoice_date >= @date_from');
      params.date_from = q.date_from;
    }
    if (q.date_to) {
      where.push('i.invoice_date <= @date_to');
      params.date_to = q.date_to;
    }
    if (q.overdue === '1') {
      where.push(`i.balance > 0 AND i.status <> 'void' AND i.due_date < date('now')`);
    }
    if (q.search) {
      where.push(
        `(i.invoice_number LIKE @search ESCAPE '\\' OR i.customer_name LIKE @search ESCAPE '\\'
          OR i.reference_number LIKE @search ESCAPE '\\')`
      );
      params.search = likeTerm(q.search);
    }

    // global rep visibility scope, on the invoice's EFFECTIVE rep (so a
    // reassigned invoice follows its new owner, not the Zoho salesperson)
    const scope = attribution.invoiceScopeFilter('i');
    if (scope.active) {
      where.push(scope.sql);
      Object.assign(params, scope.params);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderCol = sortColumn(q.sort, SORTS, 'i.invoice_date');
    const dir = sortDir(q.dir, 'DESC');

    const agg = db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN i.status <> 'void' THEN i.total ELSE 0 END), 0) AS total_amount,
                COALESCE(SUM(CASE WHEN i.status <> 'void' THEN i.balance ELSE 0 END), 0) AS total_balance
           FROM invoices i ${whereSql}`
      )
      .get(params);

    const rows = db
      .prepare(
        `SELECT i.zoho_invoice_id AS id, i.invoice_number, i.customer_id, i.customer_name,
                i.salesperson_id, i.salesperson_name, i.invoice_date, i.due_date, i.status,
                i.total, i.balance, i.reference_number, i.line_items_synced
           FROM invoices i
           ${whereSql}
          ORDER BY ${orderCol} ${dir} NULLS LAST, i.invoice_number DESC
          LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: paging.limit, offset: paging.offset });

    return res.json({
      ...listResponse(rows, agg.n, paging),
      totals: { amount: agg.total_amount, balance: agg.total_balance },
    });
  })
);

// GET /api/invoices/meta/filters — status list + salespersons for the filter bar
router.get(
  '/meta/filters',
  route((_req, res) => {
    const db = getDb();
    // the filter bar must describe the data the user can actually see
    const scope = attribution.invoiceScopeFilter('i');
    const statuses = db
      .prepare(
        `SELECT i.status AS status, COUNT(*) AS n FROM invoices i
          WHERE i.status IS NOT NULL AND ${scope.sql}
          GROUP BY i.status ORDER BY n DESC`
      )
      .all(scope.params);
    const salespersons = attribution
      .listReps({ visibleOnly: true })
      .map((r) => ({ id: r.id, name: r.name }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
    const range = db
      .prepare(
        `SELECT MIN(i.invoice_date) AS min_date, MAX(i.invoice_date) AS max_date
           FROM invoices i WHERE ${scope.sql}`
      )
      .get(scope.params);
    res.json({ statuses, salespersons, range });
  })
);

router.get(
  '/:id',
  route((req, res) => {
    const db = getDb();
    const id = String(req.params.id);

    const invoice = db
      .prepare(
        `SELECT zoho_invoice_id AS id, invoice_number, customer_id, customer_name, salesperson_id,
                salesperson_name, invoice_date, due_date, status, total, sub_total, balance,
                currency_code, reference_number, line_items_synced, line_items_synced_at,
                last_modified_time, synced_at
           FROM invoices WHERE zoho_invoice_id = ?`
      )
      .get(id);

    if (!invoice || !attribution.isInvoiceVisible(id)) {
      return res.status(404).json({ error: 'invoice not found' });
    }

    const lineItems = db
      .prepare(
        `SELECT zoho_line_item_id AS id, item_id, line_order, name, description, sku, quantity,
                unit, rate, discount_amount, item_total
           FROM invoice_line_items WHERE invoice_id = ?
          ORDER BY line_order ASC`
      )
      .all(id);

    // payments whose applied-invoice list mentions this invoice
    const payments = db
      .prepare(
        `SELECT zoho_payment_id AS id, payment_number, payment_date, amount, payment_mode,
                reference_number, applied_invoices_json
           FROM payments
          WHERE customer_id = @customer AND applied_invoices_json LIKE @needle
          ORDER BY payment_date DESC`
      )
      .all({ customer: invoice.customer_id, needle: `%"${id}"%` })
      .map((p) => {
        let applied = [];
        try {
          applied = JSON.parse(p.applied_invoices_json) || [];
        } catch {
          applied = [];
        }
        const line = applied.find((a) => String(a.invoice_id) === id);
        return {
          id: p.id,
          payment_number: p.payment_number,
          payment_date: p.payment_date,
          payment_mode: p.payment_mode,
          reference_number: p.reference_number,
          amount: p.amount,
          amount_applied: line ? Number(line.amount_applied ?? line.amount ?? 0) : null,
        };
      });

    return res.json({ invoice, lineItems, payments });
  })
);

module.exports = router;
