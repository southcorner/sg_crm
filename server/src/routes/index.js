'use strict';

/**
 * API router. Feature routers get mounted here as each phase lands
 * (customers, invoices, performance, brands, targets, reminders, zoho, whatsapp...).
 */

const express = require('express');
const authRoutes = require('./auth');
const config = require('../config');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, env: config.NODE_ENV, time: new Date().toISOString() });
});

router.use('/auth', authRoutes);

module.exports = router;
