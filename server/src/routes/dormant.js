'use strict';

/**
 * GET /api/dormant?months=&include_inactive=
 *
 * Returns the dormant customers plus the threshold actually used, so the UI can
 * say "no invoice since 30 Apr 2026" rather than making the admin do the month
 * arithmetic in their head. `months` overrides the `dormant_months` setting for
 * this request only — persisting a new default is a PUT /api/settings.
 */

const express = require('express');
const { z } = require('zod');
const { route, sendError } = require('./util');
const dormant = require('../services/dormant');

const router = express.Router();

const querySchema = z.object({
  months: z.coerce.number().int().min(1).max(dormant.MAX_MONTHS).optional(),
  include_inactive: z.enum(['0', '1', 'true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

router.get(
  '/',
  route((req, res) => {
    const parsed = querySchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const { months, include_inactive: includeInactive, limit } = parsed.data;
    return res.json(
      dormant.listDormant({
        months,
        includeInactive: includeInactive === '1' || includeInactive === 'true',
        limit,
      })
    );
  })
);

module.exports = router;
