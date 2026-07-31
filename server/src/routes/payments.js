'use strict';

/** GET /api/payments — filter by customer, mode and date range. */

const express = require('express');
const { z } = require('zod');
const { getDb } = require('../db/connection');
const { parsePaging, listResponse, route, sendError, likeTerm, sortColumn, sortDir } = require('./util');
const attribution = require('../services/attribution');

const router = express.Router();

const SORTS = {
  payment_date: 'p.payment_date',
  amount: 'p.amount',
  customer: 'p.customer_name',
  number: 'p.payment_number',
};

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .optional();

const listQuerySchema = z.object({
  customer_id: z.string().trim().optional(),
  search: z.string().trim().max(120).optional(),
  mode: z.string().trim().max(40).optional(),
  date_from: dateStr,
  date_to: dateStr,
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
      where.push('p.customer_id = @customer_id');
      params.customer_id = q.customer_id;
    }
    if (q.mode) {
      where.push('p.payment_mode = @mode');
      params.mode = q.mode;
    }
    if (q.date_from) {
      where.push('p.payment_date >= @date_from');
      params.date_from = q.date_from;
    }
    if (q.date_to) {
      where.push('p.payment_date <= @date_to');
      params.date_to = q.date_to;
    }
    if (q.search) {
      where.push(
        `(p.customer_name LIKE @search ESCAPE '\\' OR p.payment_number LIKE @search ESCAPE '\\'
          OR p.reference_number LIKE @search ESCAPE '\\')`
      );
      params.search = likeTerm(q.search);
    }

    // a payment belongs to whoever owns the customer it came from
    const scope = attribution.customerIdScopeFilter('p.customer_id');
    if (scope.active) {
      where.push(scope.sql);
      Object.assign(params, scope.params);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderCol = sortColumn(q.sort, SORTS, 'p.payment_date');
    const dir = sortDir(q.dir, 'DESC');

    const agg = db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(p.amount), 0) AS total FROM payments p ${whereSql}`)
      .get(params);

    const rows = db
      .prepare(
        `SELECT p.zoho_payment_id AS id, p.payment_number, p.customer_id, p.customer_name,
                p.payment_date, p.amount, p.unused_amount, p.payment_mode, p.reference_number,
                p.description, p.applied_invoices_json
           FROM payments p
           ${whereSql}
          ORDER BY ${orderCol} ${dir} NULLS LAST, p.payment_number DESC
          LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: paging.limit, offset: paging.offset })
      .map((p) => {
        let applied = [];
        try {
          applied = p.applied_invoices_json ? JSON.parse(p.applied_invoices_json) || [] : [];
        } catch {
          applied = [];
        }
        const { applied_invoices_json: _drop, ...rest } = p;
        return { ...rest, applied_invoices: applied };
      });

    const modes = db
      .prepare(
        `SELECT p.payment_mode AS mode, COUNT(*) AS n FROM payments p
          WHERE p.payment_mode IS NOT NULL AND ${scope.sql}
          GROUP BY p.payment_mode ORDER BY n DESC`
      )
      .all(scope.params);

    return res.json({ ...listResponse(rows, agg.n, paging), totals: { amount: agg.total }, modes });
  })
);

module.exports = router;
