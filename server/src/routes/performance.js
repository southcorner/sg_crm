'use strict';

/**
 * GET /api/performance/summary?month=YYYY-MM
 * GET /api/performance/mom?rep=&months=&brand=&end=
 * GET /api/performance/products?rep=&customer=&brand=&month=&months=&search=&sort=&dir=
 * GET /api/performance/brands?months=&rep=
 */

const express = require('express');
const { z } = require('zod');
const { route, sendError } = require('./util');
const perf = require('../services/performance');

const router = express.Router();

const MONTH = z.string().regex(/^\d{4}-\d{2}$/, 'month must look like YYYY-MM');
const BRAND = z.union([z.literal('none'), z.coerce.number().int().positive()]);

const summarySchema = z.object({ month: MONTH.optional() });

const momSchema = z.object({
  rep: z.string().trim().max(64).optional(),
  months: z.coerce.number().int().min(1).max(60).default(12),
  brand: BRAND.optional(),
  end: MONTH.optional(),
});

// whitelisted by the service; an unknown column is a 400, never a raw ORDER BY
const SORT = z.enum(perf.PRODUCT_SORT_KEYS, {
  errorMap: () => ({ message: `sort must be one of ${perf.PRODUCT_SORT_KEYS.join(' | ')}` }),
});
const DIR = z.preprocess(
  (v) => (typeof v === 'string' ? v.toLowerCase() : v),
  z.enum(['asc', 'desc'], { errorMap: () => ({ message: 'dir must be asc or desc' }) })
);

const productsSchema = z.object({
  rep: z.string().trim().max(64).optional(),
  customer: z.string().trim().max(64).optional(),
  brand: BRAND.optional(),
  month: MONTH.optional(),
  months: z.coerce.number().int().min(1).max(60).default(12),
  end: MONTH.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  search: z.string().trim().max(120).optional(),
  sort: SORT.optional(),
  dir: DIR.optional(),
});

const brandsSchema = z.object({
  months: z.coerce.number().int().min(1).max(60).default(6),
  end: MONTH.optional(),
  rep: z.string().trim().max(64).optional(),
});

router.get(
  '/summary',
  route((req, res) => {
    const parsed = summarySchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    return res.json(perf.summary(parsed.data.month));
  })
);

router.get(
  '/mom',
  route((req, res) => {
    const parsed = momSchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const { rep, months, brand, end } = parsed.data;
    return res.json(perf.mom({ rep: rep || null, months, brand: brand ?? null, endMonth: end || null }));
  })
);

router.get(
  '/products',
  route((req, res) => {
    const parsed = productsSchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const { rep, customer, brand, month, months, end, limit, search, sort, dir } = parsed.data;
    return res.json(
      perf.products({
        rep: rep || null,
        customer: customer || null,
        brand: brand ?? null,
        month: month || null,
        months,
        endMonth: end || null,
        limit,
        search: search || null,
        sort: sort || null,
        dir: dir || null,
      })
    );
  })
);

router.get(
  '/brands',
  route((req, res) => {
    const parsed = brandsSchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const { months, end, rep } = parsed.data;
    return res.json(perf.brandRollup({ months, endMonth: end || null, rep: rep || null }));
  })
);

module.exports = router;
