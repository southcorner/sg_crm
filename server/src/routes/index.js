'use strict';

/**
 * API router. Feature routers get mounted here as each phase lands
 * (customers, invoices, performance, brands, targets, reminders, zoho, whatsapp...).
 */

const express = require('express');
const authRoutes = require('./auth');
const { zohoRouter, syncRouter } = require('./zoho');
const customerRoutes = require('./customers');
const invoiceRoutes = require('./invoices');
const paymentRoutes = require('./payments');
const dashboardRoutes = require('./dashboard');
const brandRoutes = require('./brands');
const itemRoutes = require('./items');
const performanceRoutes = require('./performance');
const targetRoutes = require('./targets');
const repRoutes = require('./reps');
const config = require('../config');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, env: config.NODE_ENV, time: new Date().toISOString() });
});

router.use('/auth', authRoutes);

// phase 1 — Zoho sync + read-only views
router.use('/zoho', zohoRouter);
router.use('/sync', syncRouter);
router.use('/customers', customerRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/payments', paymentRoutes);
router.use('/dashboard', dashboardRoutes);

// phase 2 — brands, performance, targets, rep attribution
router.use('/brands', brandRoutes);
router.use('/items', itemRoutes);
router.use('/performance', performanceRoutes);
router.use('/targets', targetRoutes);
router.use('/reps', repRoutes);

module.exports = router;
