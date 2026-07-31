'use strict';

/**
 * Brands, brand rules and the item → brand mapping.
 *
 *   GET    /api/brands                 brands + rules + mapping stats
 *   POST   /api/brands                 create a brand
 *   PUT    /api/brands/:id             rename / recolour / (de)activate
 *   GET    /api/brands/rules           ordered rules
 *   POST   /api/brands/rules           create a rule
 *   PUT    /api/brands/rules/:id       edit a rule (incl. priority)
 *   DELETE /api/brands/rules/:id       drop a rule
 *   PUT    /api/brands/rules/reorder   bulk priority rewrite
 *   POST   /api/brands/remap           re-run the rules over every item
 *   GET    /api/brands/unmapped-items  items no rule claims
 */

const express = require('express');
const { z } = require('zod');
const { route, sendError } = require('./util');
const brands = require('../services/brands');

const router = express.Router();

const brandCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().trim().max(20).nullish(),
  sort_order: z.coerce.number().int().min(0).max(9999).default(0),
  notes: z.string().trim().max(500).nullish(),
  is_active: z.coerce.boolean().default(true),
});

const brandUpdateSchema = brandCreateSchema.partial();

const ruleCreateSchema = z.object({
  brand_id: z.coerce.number().int().positive(),
  rule_type: z.enum(['custom_field', 'category', 'name_pattern', 'sku_pattern']),
  custom_field_name: z.string().trim().max(80).nullish(),
  match_value: z.string().trim().min(1).max(200),
  priority: z.coerce.number().int().min(0).max(100000).default(100),
  is_active: z.coerce.boolean().default(true),
});

const ruleUpdateSchema = ruleCreateSchema.partial();

const reorderSchema = z.object({
  order: z
    .array(z.object({ id: z.coerce.number().int().positive(), priority: z.coerce.number().int().min(0).max(100000) }))
    .min(1),
});

const unmappedQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- brands ----------------------------------------------------------------

router.get(
  '/',
  route((_req, res) => {
    res.json({
      brands: brands.listBrands(),
      rules: brands.listRules(),
      stats: brands.mappingStats(),
    });
  })
);

router.post(
  '/',
  route((req, res) => {
    const parsed = brandCreateSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const brand = brands.createBrand(parsed.data);
    return res.status(201).json({ brand, brands: brands.listBrands() });
  })
);

// --- rules (declared before /:id so 'rules' is never read as a brand id) ----

router.get(
  '/rules',
  route((_req, res) => res.json({ rules: brands.listRules(), brands: brands.listBrands() }))
);

router.post(
  '/rules',
  route((req, res) => {
    const parsed = ruleCreateSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const result = brands.createRule(parsed.data);
    return res.status(201).json({ ...result, rules: brands.listRules(), stats: brands.mappingStats() });
  })
);

router.put(
  '/rules/reorder',
  route((req, res) => {
    const parsed = reorderSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const result = brands.reorderRules(parsed.data.order);
    return res.json({ ...result, stats: brands.mappingStats() });
  })
);

router.put(
  '/rules/:id',
  route((req, res) => {
    const parsed = ruleUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const result = brands.updateRule(Number(req.params.id), parsed.data);
    return res.json({ ...result, rules: brands.listRules(), stats: brands.mappingStats() });
  })
);

router.delete(
  '/rules/:id',
  route((req, res) => {
    const result = brands.deleteRule(Number(req.params.id));
    return res.json({ ...result, rules: brands.listRules(), stats: brands.mappingStats() });
  })
);

// --- mapping ---------------------------------------------------------------

router.post(
  '/remap',
  route((_req, res) => {
    const remap = brands.remapItems();
    return res.json({ remap, stats: brands.mappingStats() });
  })
);

router.get(
  '/unmapped-items',
  route((req, res) => {
    const parsed = unmappedQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const { rows, total } = brands.unmappedItems(parsed.data);
    return res.json({ rows, total, stats: brands.mappingStats() });
  })
);

// --- single brand ----------------------------------------------------------

router.put(
  '/:id',
  route((req, res) => {
    const parsed = brandUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const result = brands.updateBrand(Number(req.params.id), parsed.data);
    return res.json({ ...result, brands: brands.listBrands(), stats: brands.mappingStats() });
  })
);

module.exports = router;
