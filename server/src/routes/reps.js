'use strict';

/**
 * GET /api/reps       salespersons + their CRM-owned contact / notify config
 * PUT /api/reps/:id   edit crm_email, whatsapp_number, notify flags, is_active
 *
 * Only the CRM-owned columns are writable here — the Zoho name/email are
 * overwritten by every sync and must not be edited in the CRM.
 */

const express = require('express');
const { z } = require('zod');
const { route, sendError } = require('./util');
const attribution = require('../services/attribution');

const router = express.Router();

const updateSchema = z.object({
  crm_email: z.union([z.string().trim().email(), z.literal('')]).nullish(),
  whatsapp_number: z
    .string()
    .trim()
    .max(20)
    .refine((v) => v === '' || /^[\d+\s-]{8,20}$/.test(v), 'whatsapp_number must be 8-20 digits')
    .nullish(),
  notify_email: z.coerce.boolean().optional(),
  notify_whatsapp: z.coerce.boolean().optional(),
  is_active: z.coerce.boolean().optional(),
  notes: z.string().trim().max(500).nullish(),
});

router.get(
  '/',
  route((_req, res) => res.json({ rows: attribution.listReps() }))
);

router.put(
  '/:id',
  route((req, res) => {
    const parsed = updateSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const rep = attribution.updateRep(String(req.params.id), parsed.data);
    return res.json({ rep, rows: attribution.listReps() });
  })
);

module.exports = router;
