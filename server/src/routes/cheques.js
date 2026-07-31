'use strict';

/**
 * GET    /api/cheques?status=&due_before=&due_after=&customer=
 * GET    /api/cheques/due?days=N     pending cheques depositing exactly N days out
 * POST   /api/cheques                {customer_id, amount, cheque_number, bank_name?,
 *                                     received_date?, deposit_date, note?}
 * PUT    /api/cheques/:id            any field + status + zoho_payment_id
 * DELETE /api/cheques/:id
 *
 * `status` accepts a comma-separated list (?status=pending,bounced) or repeated
 * params, matching the filter chips in the UI.
 */

const express = require('express');
const { z } = require('zod');
const { route, sendError } = require('./util');
const cheques = require('../services/cheques');

const router = express.Router();

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must look like YYYY-MM-DD');
const STATUS = z.enum(cheques.STATUSES);

const statusParam = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (!v) return [];
    const parts = (Array.isArray(v) ? v : [v]).flatMap((s) => String(s).split(','));
    return parts.map((s) => s.trim()).filter(Boolean);
  })
  .refine((list) => list.every((s) => cheques.STATUSES.includes(s)), {
    message: `status must be one of ${cheques.STATUSES.join(' | ')}`,
  });

const listSchema = z.object({
  status: statusParam,
  due_before: DATE.optional(),
  due_after: DATE.optional(),
  customer: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

const createSchema = z.object({
  customer_id: z.string().trim().min(1).max(64),
  amount: z.coerce.number().min(0).max(1e12),
  cheque_number: z.string().trim().max(50).nullish(),
  bank_name: z.string().trim().max(120).nullish(),
  received_date: DATE.nullish(),
  cheque_date: DATE.nullish(),
  deposit_date: DATE,
  status: STATUS.optional(),
  salesperson_id: z.string().trim().max(64).nullish(),
  zoho_payment_id: z.string().trim().max(64).nullish(),
  note: z.string().trim().max(500).nullish(),
});

const updateSchema = z
  .object({
    customer_id: z.string().trim().min(1).max(64).optional(),
    amount: z.coerce.number().min(0).max(1e12).optional(),
    cheque_number: z.string().trim().max(50).nullish(),
    bank_name: z.string().trim().max(120).nullish(),
    received_date: z.union([DATE, z.literal('')]).nullish(),
    cheque_date: z.union([DATE, z.literal('')]).nullish(),
    deposit_date: DATE.optional(),
    status: STATUS.optional(),
    salesperson_id: z.string().trim().max(64).nullish(),
    zoho_payment_id: z.string().trim().max(64).nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

router.get(
  '/',
  route((req, res) => {
    const parsed = listSchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const q = parsed.data;
    return res.json(
      cheques.listCheques({
        status: q.status,
        dueBefore: q.due_before || null,
        dueAfter: q.due_after || null,
        customer: q.customer || null,
        limit: q.limit,
      })
    );
  })
);

// the reusable reminder query, exposed for spot-checking from the UI / curl
router.get(
  '/due',
  route((req, res) => {
    const parsed = z.object({ days: z.coerce.number().int().min(0).max(365).default(0) }).safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const rows = cheques.chequesDueInDays(parsed.data.days);
    return res.json({ days: parsed.data.days, rows, count: rows.length });
  })
);

router.post(
  '/',
  route((req, res) => {
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    return res.status(201).json({ cheque: cheques.createCheque(parsed.data) });
  })
);

router.put(
  '/:id',
  route((req, res) => {
    const parsed = updateSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    return res.json({ cheque: cheques.updateCheque(req.params.id, parsed.data) });
  })
);

router.delete(
  '/:id',
  route((req, res) => res.json(cheques.deleteCheque(req.params.id)))
);

module.exports = router;
