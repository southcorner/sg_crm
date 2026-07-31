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

module.exports = router;
