'use strict';

/**
 * GET /api/dashboard — KPI tiles.
 *
 * Voided invoices are excluded from every money figure; drafts count towards
 * "invoiced" but never towards outstanding/overdue.
 */

const express = require('express');
const { getDb } = require('../db/connection');
const { route } = require('./util');
const sync = require('../zoho/sync');
const auth = require('../zoho/auth');

const router = express.Router();

router.get(
  '/',
  route((_req, res) => {
    const db = getDb();

    const customers = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN outstanding_receivable > 0 THEN 1 ELSE 0 END) AS with_outstanding
           FROM customers`
      )
      .get();

    const mtd = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS amount
           FROM invoices
          WHERE status <> 'void'
            AND invoice_date >= date('now', 'start of month')
            AND invoice_date <= date('now')`
      )
      .get();

    const lastMonth = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS amount
           FROM invoices
          WHERE status <> 'void'
            AND invoice_date >= date('now', 'start of month', '-1 month')
            AND invoice_date < date('now', 'start of month')`
      )
      .get();

    const outstanding = db
      .prepare(
        `SELECT COALESCE(SUM(balance), 0) AS amount, COUNT(*) AS count
           FROM invoices
          WHERE balance > 0 AND status <> 'void' AND status <> 'draft'`
      )
      .get();

    const overdue = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(balance), 0) AS amount
           FROM invoices
          WHERE balance > 0 AND status <> 'void' AND status <> 'draft'
            AND due_date IS NOT NULL AND due_date < date('now')`
      )
      .get();

    const paymentsMtd = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
           FROM payments
          WHERE payment_date >= date('now', 'start of month') AND payment_date <= date('now')`
      )
      .get();

    const topOutstanding = db
      .prepare(
        `SELECT zoho_contact_id AS id, contact_name, outstanding_receivable, last_invoice_date
           FROM customers
          WHERE outstanding_receivable > 0
          ORDER BY outstanding_receivable DESC
          LIMIT 5`
      )
      .all();

    const recentInvoices = db
      .prepare(
        `SELECT zoho_invoice_id AS id, invoice_number, customer_name, invoice_date, total, balance, status
           FROM invoices
          WHERE status <> 'void'
          ORDER BY invoice_date DESC, invoice_number DESC
          LIMIT 5`
      )
      .all();

    const syncStatus = sync.getSyncStatus();

    res.json({
      kpis: {
        customers: {
          total: Number(customers.total || 0),
          active: Number(customers.active || 0),
          withOutstanding: Number(customers.with_outstanding || 0),
        },
        mtdInvoiced: { amount: mtd.amount, count: mtd.count },
        lastMonthInvoiced: { amount: lastMonth.amount, count: lastMonth.count },
        outstanding: { amount: outstanding.amount, count: outstanding.count },
        overdue: { amount: overdue.amount, count: overdue.count },
        mtdPayments: { amount: paymentsMtd.amount, count: paymentsMtd.count },
      },
      topOutstanding,
      recentInvoices,
      sync: {
        running: syncStatus.running,
        connected: syncStatus.connected,
        entities: syncStatus.entities.map((e) => ({
          entity: e.entity,
          lastRunAt: e.lastRunAt,
          lastStatus: e.lastStatus,
          rowCount: e.rowCount,
        })),
        lineItems: syncStatus.lineItems,
        apiCalls: auth.getStatus().apiCalls,
      },
    });
  })
);

module.exports = router;
