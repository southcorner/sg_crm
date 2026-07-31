'use strict';

/**
 * GET /api/items              items with their current brand mapping
 * PUT /api/items/:id/brand    manual override; {brand_id: null} reverts to rules
 */

const express = require('express');
const { z } = require('zod');
const { route, sendError, parsePaging, listResponse } = require('./util');
const brands = require('../services/brands');

const router = express.Router();

const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  brand_id: z.union([z.literal('none'), z.coerce.number().int().positive()]).optional(),
  source: z.enum(['rule', 'manual']).optional(),
});

const brandBodySchema = z.object({
  brand_id: z.coerce.number().int().positive().nullable(),
});

router.get(
  '/',
  route((req, res) => {
    const parsed = listQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const paging = parsePaging(req.query || {});
    const { rows, total } = brands.listItems({
      ...parsed.data,
      limit: paging.limit,
      offset: paging.offset,
    });
    return res.json({ ...listResponse(rows, total, paging), stats: brands.mappingStats() });
  })
);

router.put(
  '/:id/brand',
  route((req, res) => {
    const body = req.body || {};
    // an explicit null is the documented way to hand the item back to the rules
    const parsed = brandBodySchema.safeParse({ brand_id: body.brand_id ?? null });
    if (!parsed.success) return sendError(res, parsed.error);
    const item = brands.setItemBrand(String(req.params.id), parsed.data.brand_id);
    return res.json({ item, stats: brands.mappingStats() });
  })
);

module.exports = router;
