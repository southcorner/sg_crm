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
const perf = require('../services/performance');
const cheques = require('../services/cheques');
const dormant = require('../services/dormant');
const focus = require('../services/focus');
const reminders = require('../services/reminders/engine');
const whatsapp = require('../services/reminders/whatsapp');
const attribution = require('../services/attribution');

const router = express.Router();

router.get(
  '/',
  route((_req, res) => {
    const db = getDb();

    // Every tile below is filtered to the visible reps (unattributed always
    // counts). `cust` scopes rows that hang off a customer, `inv` scopes rows
    // that hang off an invoice's own effective rep — same helper, two anchors.
    const cust = attribution.customerScopeFilter('c');
    const inv = attribution.invoiceScopeFilter('i');

    const customers = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN c.outstanding_receivable > 0 THEN 1 ELSE 0 END) AS with_outstanding
           FROM customers c
          WHERE ${cust.sql}`
      )
      .get(cust.params);

    const mtd = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(i.total), 0) AS amount
           FROM invoices i
          WHERE i.status <> 'void'
            AND i.invoice_date >= date('now', 'start of month')
            AND i.invoice_date <= date('now')
            AND ${inv.sql}`
      )
      .get(inv.params);

    const lastMonth = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(i.total), 0) AS amount
           FROM invoices i
          WHERE i.status <> 'void'
            AND i.invoice_date >= date('now', 'start of month', '-1 month')
            AND i.invoice_date < date('now', 'start of month')
            AND ${inv.sql}`
      )
      .get(inv.params);

    const outstanding = db
      .prepare(
        `SELECT COALESCE(SUM(i.balance), 0) AS amount, COUNT(*) AS count
           FROM invoices i
          WHERE i.balance > 0 AND i.status <> 'void' AND i.status <> 'draft'
            AND ${inv.sql}`
      )
      .get(inv.params);

    const overdue = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(i.balance), 0) AS amount
           FROM invoices i
          WHERE i.balance > 0 AND i.status <> 'void' AND i.status <> 'draft'
            AND i.due_date IS NOT NULL AND i.due_date < date('now')
            AND ${inv.sql}`
      )
      .get(inv.params);

    const payScope = attribution.customerIdScopeFilter('p.customer_id');
    const paymentsMtd = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(p.amount), 0) AS amount
           FROM payments p
          WHERE p.payment_date >= date('now', 'start of month')
            AND p.payment_date <= date('now')
            AND ${payScope.sql}`
      )
      .get(payScope.params);

    const topOutstanding = db
      .prepare(
        `SELECT c.zoho_contact_id AS id, c.contact_name, c.outstanding_receivable, c.last_invoice_date
           FROM customers c
          WHERE c.outstanding_receivable > 0 AND ${cust.sql}
          ORDER BY c.outstanding_receivable DESC
          LIMIT 5`
      )
      .all(cust.params);

    const recentInvoices = db
      .prepare(
        `SELECT i.zoho_invoice_id AS id, i.invoice_number, i.customer_name, i.invoice_date,
                i.total, i.balance, i.status
           FROM invoices i
          WHERE i.status <> 'void' AND ${inv.sql}
          ORDER BY i.invoice_date DESC, i.invoice_number DESC
          LIMIT 5`
      )
      .all(inv.params);

    const syncStatus = sync.getSyncStatus();

    // phase 3 workflow tiles
    const chequeStats = cheques.chequeSummary();
    const dormantStats = dormant.dormantCount();
    const focusStats = focus.openFocusCount();

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
        cheques: {
          pending: chequeStats.pending,
          next7: chequeStats.next7,
          pastDue: chequeStats.pastDue,
          leadDays: chequeStats.leadDays,
        },
        dormant: {
          count: dormantStats.count,
          months: dormantStats.months,
          threshold: dormantStats.threshold,
          outstanding: dormantStats.outstanding,
        },
        focus: { month: focusStats.month, open: focusStats.open, total: focusStats.total },
      },
      topOutstanding,
      recentInvoices,
      // MTD split by brand (line-item derived — see services/performance.js)
      mtdBrands: perf.mtdBrands(),
      // phase 4 — who got their digest today / yesterday, and on which channel
      reminders: reminders.digestStatus(),
      // phase 5 — session state for the "scan the QR" banner. The QR itself is
      // deliberately left out: it belongs on the Settings page, not here.
      whatsapp: whatsapp.getStatus({ includeQr: false }),
      // so the UI can say "showing X of Y reps" instead of the admin reading
      // a filtered dashboard as missing data
      repScope: attribution.repScopeSummary(),
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
