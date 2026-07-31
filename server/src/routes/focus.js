'use strict';

/**
 * GET    /api/focus?month=YYYY-MM   the month's plan (defaults to this month)
 * POST   /api/focus                 {month?, customer_id, salesperson_id?, note?}
 * PUT    /api/focus/:id             {note?, status?, salesperson_id?}
 * DELETE /api/focus/:id
 *
 * A customer can only appear once per month — the duplicate comes back as a 409
 * carrying the id of the row that already exists, so the UI can jump to it.
 */

const express = require('express');
const { z } = require('zod');
const { route, sendError } = require('./util');
const focus = require('../services/focus');
const attribution = require('../services/attribution');

const router = express.Router();

const MONTH = z.string().regex(/^\d{4}-\d{2}$/, 'month must look like YYYY-MM');

const getSchema = z.object({ month: MONTH.optional() });

const createSchema = z.object({
  month: MONTH.optional(),
  customer_id: z.string().trim().min(1).max(64),
  salesperson_id: z.string().trim().max(64).nullish(),
  note: z.string().trim().max(500).nullish(),
  status: z.enum(['open', 'done', 'dropped']).optional(),
});

const updateSchema = z
  .object({
    note: z.string().trim().max(500).nullish(),
    status: z.enum(['open', 'done', 'dropped']).optional(),
    salesperson_id: z.string().trim().max(64).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

router.get(
  '/',
  route((req, res) => {
    const parsed = getSchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    return res.json({
      ...focus.listFocus(parsed.data.month),
      reps: attribution.listReps({ includeInactive: false, visibleOnly: true }),
    });
  })
);

router.post(
  '/',
  route((req, res) => {
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    try {
      return res.status(201).json({ item: focus.createFocus(parsed.data) });
    } catch (err) {
      if (err.status === 409) {
        return res.status(409).json({ error: err.message, focus_id: err.focus_id });
      }
      throw err;
    }
  })
);

router.put(
  '/:id',
  route((req, res) => {
    const parsed = updateSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    return res.json({ item: focus.updateFocus(req.params.id, parsed.data) });
  })
);

router.delete(
  '/:id',
  route((req, res) => res.json(focus.deleteFocus(req.params.id)))
);

module.exports = router;
