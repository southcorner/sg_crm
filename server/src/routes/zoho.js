'use strict';

/**
 * Zoho connection + sync control.
 *
 *   POST /api/zoho/connect      exchange a Self Client grant code
 *   GET  /api/zoho/status       connection + today's API budget
 *   POST /api/zoho/disconnect   forget stored credentials
 *   POST /api/sync/run          start a sync (returns immediately)
 *   GET  /api/sync/status       per-entity cursors, counts, line-item progress
 */

const express = require('express');
const { z } = require('zod');
const auth = require('../zoho/auth');
const sync = require('../zoho/sync');
const config = require('../config');
const logger = require('../logger');
const { asyncRoute, route, sendError } = require('./util');

const zohoRouter = express.Router();
const syncRouter = express.Router();

const connectSchema = z.object({
  grant_code: z.string().trim().min(5, 'grant code is required'),
  client_id: z.string().trim().min(1).optional(),
  client_secret: z.string().trim().min(1).optional(),
});

zohoRouter.post(
  '/connect',
  asyncRoute(async (req, res) => {
    const parsed = connectSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);

    try {
      const status = await auth.connect({
        grantCode: parsed.data.grant_code,
        clientId: parsed.data.client_id,
        clientSecret: parsed.data.client_secret,
      });
      return res.json({ ok: true, status });
    } catch (err) {
      logger.warn({ err: err.message }, 'zoho connect failed');
      return res.status(400).json({ error: err.message });
    }
  })
);

zohoRouter.get(
  '/status',
  route((_req, res) => {
    res.json(auth.getStatus());
  })
);

zohoRouter.post(
  '/disconnect',
  route((_req, res) => {
    auth.disconnect();
    res.json({ ok: true, status: auth.getStatus() });
  })
);

// PUT /api/zoho/budget — adjust the daily API call budget from the UI
const budgetSchema = z.object({ budget: z.coerce.number().int().min(50).max(100000) });
zohoRouter.put(
  '/budget',
  route((req, res) => {
    const parsed = budgetSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    config.setSetting('zoho_daily_call_budget', parsed.data.budget);
    return res.json({ ok: true, status: auth.getStatus() });
  })
);

// ---------------------------------------------------------------------------

const runSchema = z.object({
  entity: z.enum([...sync.SYNC_ENTITIES, 'invoice_details', 'all']).optional(),
});

syncRouter.post(
  '/run',
  route((req, res) => {
    const parsed = runSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);

    if (!auth.isConnected()) {
      return res.status(400).json({ error: 'Zoho is not connected — connect it in Settings first' });
    }
    if (sync.isRunning()) {
      return res.status(409).json({ error: 'a sync is already running', status: sync.getSyncStatus() });
    }

    const entity = parsed.data.entity && parsed.data.entity !== 'all' ? parsed.data.entity : null;
    const started = sync.startSync(entity ? { entities: [entity] } : {});

    return res.status(202).json({ ...started, entity: entity || 'all' });
  })
);

syncRouter.get(
  '/status',
  route((_req, res) => {
    res.json(sync.getSyncStatus());
  })
);

module.exports = { zohoRouter, syncRouter };
