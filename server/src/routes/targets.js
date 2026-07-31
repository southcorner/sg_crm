'use strict';

/**
 * GET /api/targets?month=YYYY-MM   the rep × (overall + brand) grid
 * PUT /api/targets                 bulk upsert of grid cells
 *
 * A cell with target_amount 0 (or blank) deletes the row, so clearing a cell in
 * the UI does the obvious thing and the grid never fills with zero rows.
 */

const express = require('express');
const { z } = require('zod');
const { route, sendError } = require('./util');
const perf = require('../services/performance');

const router = express.Router();

const MONTH = z.string().regex(/^\d{4}-\d{2}$/, 'month must look like YYYY-MM');

const getSchema = z.object({ month: MONTH.optional() });

const putSchema = z.object({
  month: MONTH,
  rows: z
    .array(
      z.object({
        salesperson_id: z.string().trim().min(1).max(64),
        brand_id: z.coerce.number().int().positive().nullish(),
        target_amount: z.coerce.number().min(0).max(1e12).default(0),
        note: z.string().trim().max(300).nullish(),
      })
    )
    .max(2000),
});

router.get(
  '/',
  route((req, res) => {
    const parsed = getSchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    return res.json(perf.getTargets(parsed.data.month));
  })
);

router.put(
  '/',
  route((req, res) => {
    const parsed = putSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const { month, rows } = parsed.data;
    return res.json(perf.upsertTargets(month, rows));
  })
);

module.exports = router;
