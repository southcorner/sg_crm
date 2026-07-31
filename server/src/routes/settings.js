'use strict';

/**
 * GET /api/settings   the UI-editable settings (and only those)
 * PUT /api/settings   partial update — send just the keys you are changing
 *
 * Deliberately a whitelist rather than a dump of the `settings` table: that
 * table also holds the Zoho client secret and refresh token, which must never
 * reach the browser. Zoho credentials are managed by /api/zoho/*, the WhatsApp
 * session by /api/whatsapp/* — this endpoint is for plain scalar config.
 *
 * Phase 4 extends EDITABLE with the digest/SMTP keys.
 */

const express = require('express');
const { z } = require('zod');
const { route, sendError } = require('./util');
const config = require('../config');

const router = express.Router();

/** key → zod schema. Anything not listed here is neither read nor written. */
const EDITABLE = {
  dormant_months: z.coerce.number().int().min(1).max(120),
  cheque_lead_days: z.coerce.number().int().min(0).max(60),
};

const putSchema = z
  .object(Object.fromEntries(Object.entries(EDITABLE).map(([k, s]) => [k, s.optional()])))
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'no editable settings in the request body');

function readAll() {
  const all = config.getAllSettings();
  return Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, all[k] ?? config.SETTING_DEFAULTS[k]]));
}

router.get(
  '/',
  route((_req, res) => res.json({ settings: readAll(), editable: Object.keys(EDITABLE) }))
);

router.put(
  '/',
  route((req, res) => {
    const parsed = putSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const updated = [];
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      config.setSetting(key, value);
      updated.push(key);
    }
    return res.json({ settings: readAll(), updated });
  })
);

module.exports = router;
