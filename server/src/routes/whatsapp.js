'use strict';

/**
 * GET  /api/whatsapp/status    the state machine + the QR when one is pending
 * POST /api/whatsapp/enable    persist whatsapp_enabled=true and bring a client up
 * POST /api/whatsapp/disable   persist false and tear the client down
 * POST /api/whatsapp/restart   destroy + fresh init (the "it went weird" button)
 * POST /api/whatsapp/logout    unlink the phone and delete data/wwebjs
 * POST /api/whatsapp/test      {number?} — one message, default whatsapp_test_number
 *
 * Nothing here waits for pairing: enable/restart return the moment the browser
 * launch has been kicked off, and the Settings page polls /status every 3 s
 * until a QR (or a ready session) appears.
 */

const express = require('express');
const { z } = require('zod');
const { route, asyncRoute, sendError } = require('./util');
const config = require('../config');
const whatsapp = require('../services/reminders/whatsapp');
const logger = require('../logger');

const router = express.Router();

const numberSchema = z
  .string()
  .trim()
  .max(24)
  .refine((v) => /^[\d+\s()-]{8,24}$/.test(v), 'a whatsapp number is 8–24 digits');

router.get(
  '/status',
  route((_req, res) => res.json({ ...whatsapp.getStatus(), testNumber: config.getSetting('whatsapp_test_number', '') }))
);

router.post(
  '/enable',
  asyncRoute(async (_req, res) => {
    const status = await whatsapp.setEnabled(true);
    logger.info('whatsapp channel enabled');
    return res.json(status);
  })
);

router.post(
  '/disable',
  asyncRoute(async (_req, res) => {
    const status = await whatsapp.setEnabled(false);
    logger.info('whatsapp channel disabled');
    return res.json(status);
  })
);

router.post(
  '/restart',
  asyncRoute(async (_req, res) => {
    if (!whatsapp.isEnabled()) {
      return res.status(409).json({ error: 'whatsapp is disabled — enable it first' });
    }
    return res.json(await whatsapp.restart());
  })
);

router.post(
  '/logout',
  asyncRoute(async (_req, res) => {
    const result = await whatsapp.logout();
    logger.info({ removed: result.removed }, 'whatsapp session unlinked');
    return res.json(result);
  })
);

router.post(
  '/test',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ number: numberSchema.optional() }).safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);

    const number = parsed.data.number || null;
    try {
      const result = await whatsapp.sendTest(number);
      // remember whatever worked, so the next test is one click
      if (number) config.setSetting('whatsapp_test_number', number);
      return res.json(result);
    } catch (err) {
      logger.warn({ err: err.message, number }, 'whatsapp test message failed');
      return res.status(err.status || 502).json({ ok: false, error: err.message, status: whatsapp.getStatus({ includeQr: false }) });
    }
  })
);

module.exports = router;
