'use strict';

/**
 * GET  /api/stock-report/preview   compose today's report and hand back the HTML
 * POST /api/stock-report/send      send it now {force?: true}
 * GET  /api/stock-report/options   brands + categories present in current stock
 *
 * The preview is the real composer, honouring every setting — including
 * unsaved ones, which may be passed as query params so the Settings page can
 * show the effect of a threshold or an exclusion before anyone commits to it.
 *
 * `send` respects the once-per-day guard unless {force:true}; the UI says so.
 * It also ignores the enabled flag, because "Send now" is an explicit act — the
 * flag only governs the scheduler.
 */

const express = require('express');
const { z } = require('zod');
const { route, asyncRoute, sendError } = require('./util');
const stock = require('../services/stock');
const stockReport = require('../services/stock-report');
const email = require('../services/reminders/email');

const router = express.Router();

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must look like YYYY-MM-DD');

/** ?a=1&a=2 or ?a=1,2 → ['1','2'] */
const listParam = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const parts = (Array.isArray(v) ? v : [v]).flatMap((s) => String(s).split(','));
    return parts.map((s) => s.trim()).filter(Boolean);
  });

const previewSchema = z.object({
  date: DATE.optional(),
  threshold: z.coerce.number().int().min(1).max(10000).optional(),
  excluded_brands: listParam,
  excluded_categories: listParam,
});

router.get(
  '/preview',
  route((req, res) => {
    const parsed = previewSchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const q = parsed.data;

    const override = {};
    if (q.threshold !== undefined) override.threshold = q.threshold;
    if (q.excluded_brands !== undefined) override.excludedBrands = q.excluded_brands.map(Number);
    if (q.excluded_categories !== undefined) override.excludedCategories = q.excluded_categories;

    const report = stockReport.compose({
      date: q.date,
      settings: Object.keys(override).length ? override : null,
    });

    return res.json({
      runDate: report.runDate,
      subject: report.subject,
      html: report.html,
      text: report.text,
      counts: report.counts,
      threshold: report.threshold,
      brands: report.brands,
      excluded: report.excluded,
      sync: report.sync,
      recipients: report.recipients,
      settings: stockReport.reportSettings(),
      smtp: email.status(),
      lastRuns: stockReport.lastRun({}),
    });
  })
);

router.get(
  '/options',
  route((_req, res) =>
    res.json({
      brands: stock.availableBrands({}),
      categories: stock.availableCategories({}),
      settings: stockReport.reportSettings(),
    })
  )
);

router.post(
  '/send',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({ date: DATE.optional(), force: z.coerce.boolean().optional() })
      .safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);

    const result = await stockReport.sendReport({
      date: parsed.data.date,
      force: Boolean(parsed.data.force),
      ignoreEnabled: true, // pressing the button IS the intent
    });

    const status = result.status === 'failed' ? 502 : 200;
    return res.status(status).json({
      runDate: result.runDate,
      status: result.status,
      sent: Boolean(result.sent),
      reason: result.reason || null,
      error: result.error || null,
      recipients: (result.recipients || []).length,
      counts: result.report ? result.report.counts : null,
      syncNote: result.syncNote || null,
      lastRuns: stockReport.lastRun({}),
    });
  })
);

module.exports = router;
