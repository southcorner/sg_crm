'use strict';

/**
 * Recipient profiles
 *   GET    /api/stock-report/profiles              list + the options to build one
 *   POST   /api/stock-report/profiles              create (never sends anything)
 *   PUT    /api/stock-report/profiles/:id          update
 *   DELETE /api/stock-report/profiles/:id          delete
 *   GET    /api/stock-report/profiles/:id/preview  that profile's composed mail
 *   GET    /api/stock-report/profiles/:id/file     that profile's HTML browser
 *
 * Ad-hoc
 *   GET  /api/stock-report/file?brands=&categories=&threshold=  custom download
 *   GET  /api/stock-report/options                              brands + categories in stock
 *   GET  /api/stock-report/preview                              ad-hoc composed mail
 *   POST /api/stock-report/send  {profile_id?, force?}          send now
 *
 * Creating a profile deliberately sends nothing: a new profile joins the next
 * scheduled run. `send` respects each profile's once-per-day guard unless
 * {force:true}, and ignores the master enabled switch because pressing the
 * button is the intent.
 */

const express = require('express');
const { z } = require('zod');
const { route, asyncRoute, sendError } = require('./util');
const stock = require('../services/stock');
const stockHtml = require('../services/stock-html');
const stockReport = require('../services/stock-report');
const email = require('../services/reminders/email');

const router = express.Router();

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must look like YYYY-MM-DD');
const THRESHOLD = z.coerce.number().int().min(1).max(stockReport.MAX_THRESHOLD);

/** ?a=1&a=2 or ?a=1,2 → ['1','2'] */
const listParam = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const parts = (Array.isArray(v) ? v : [v]).flatMap((s) => String(s).split(','));
    return parts.map((s) => s.trim()).filter(Boolean);
  });

/** Brand ids are integers (0 = the Unbranded bucket); anything else is a 400. */
const brandIdList = listParam.refine((v) => v === undefined || v.every((s) => /^\d+$/.test(s)), {
  message: 'brands must be numeric brand ids',
});

const fileQuerySchema = z.object({
  date: DATE.optional(),
  threshold: THRESHOLD.default(stockReport.DEFAULT_THRESHOLD),
  brands: brandIdList,
  categories: listParam,
  title: z.string().trim().max(120).optional(),
});

const profileBodySchema = z.object({
  name: z.string().trim().min(1, 'a profile needs a name').max(120),
  recipients: z.array(z.string().trim().email('not a valid email address')).max(200).default([]),
  excludedBrands: z.array(z.coerce.number().int().min(0)).max(500).default([]),
  excludedCategories: z.array(z.string().trim().max(120)).max(500).default([]),
  threshold: THRESHOLD.default(stockReport.DEFAULT_THRESHOLD),
  enabled: z.coerce.boolean().default(true),
  note: z.string().trim().max(500).nullish(),
});

const profilePatchSchema = profileBodySchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

/** Everything the Settings tab needs to render the profile editors. */
function options() {
  return {
    brands: stock.availableBrands({}),
    categories: stock.availableCategories({}),
    settings: stockReport.reportSettings(),
    defaultThreshold: stockReport.DEFAULT_THRESHOLD,
    smtp: email.status(),
    sync: stockReport.itemsSyncState({}),
  };
}

function sendHtmlFile(res, file) {
  const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`
  );
  res.setHeader('Content-Length', Buffer.byteLength(file.html, 'utf8'));
  // a stock file is a snapshot; never let a proxy hand yesterday's back
  res.setHeader('Cache-Control', 'no-store');
  return res.send(file.html);
}

function previewPayload(report) {
  return {
    runDate: report.runDate,
    profileId: report.profileId,
    profileName: report.profileName,
    subject: report.subject,
    html: report.html,
    text: report.text,
    counts: report.counts,
    threshold: report.threshold,
    brands: report.brands,
    excluded: report.excluded,
    sync: report.sync,
    recipients: report.recipients,
    file: report.file,
    attachmentBytes: Buffer.byteLength(report.attachment.content, 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// options + ad-hoc
// ---------------------------------------------------------------------------

router.get(
  '/options',
  route((_req, res) => res.json(options()))
);

router.get(
  '/file',
  route((req, res) => {
    const parsed = fileQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const q = parsed.data;

    const file = stockHtml.generate({
      excludedBrands: (q.brands || []).map(Number),
      excludedCategories: q.categories || [],
      threshold: q.threshold,
      ...(q.date ? { date: q.date } : {}),
      ...(q.title ? { title: q.title } : {}),
    });
    return sendHtmlFile(res, file);
  })
);

router.get(
  '/preview',
  route((req, res) => {
    const parsed = fileQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const q = parsed.data;

    const report = stockReport.compose({
      date: q.date,
      profile: {
        id: null,
        name: 'Ad-hoc preview',
        recipients: [],
        threshold: q.threshold,
        excludedBrands: (q.brands || []).map(Number),
        excludedCategories: q.categories || [],
      },
    });
    return res.json(previewPayload(report));
  })
);

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

router.get(
  '/profiles',
  route((_req, res) =>
    res.json({
      profiles: stockReport.listProfiles({}),
      ...options(),
      lastRuns: stockReport.lastRun({}),
    })
  )
);

router.post(
  '/profiles',
  route((req, res) => {
    const parsed = profileBodySchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const profile = stockReport.createProfile(parsed.data, {});
    // deliberately no send: a new profile joins the next scheduled run
    return res.status(201).json({ profile, profiles: stockReport.listProfiles({}) });
  })
);

router.put(
  '/profiles/:id',
  route((req, res) => {
    const parsed = profilePatchSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const profile = stockReport.updateProfile(req.params.id, parsed.data, {});
    return res.json({ profile, profiles: stockReport.listProfiles({}) });
  })
);

router.delete(
  '/profiles/:id',
  route((req, res) => {
    const result = stockReport.deleteProfile(req.params.id, {});
    return res.json({ ...result, profiles: stockReport.listProfiles({}) });
  })
);

function requireProfile(req) {
  const profile = stockReport.getProfile(req.params.id, {});
  if (!profile) {
    const err = new Error('profile not found');
    err.status = 404;
    throw err;
  }
  return profile;
}

router.get(
  '/profiles/:id/preview',
  route((req, res) => {
    const profile = requireProfile(req);
    const parsed = z.object({ date: DATE.optional() }).safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const report = stockReport.compose({ profile, date: parsed.data.date });
    return res.json({
      ...previewPayload(report),
      profile,
      lastRuns: stockReport.lastRun({ profileId: profile.id }),
    });
  })
);

router.get(
  '/profiles/:id/file',
  route((req, res) => {
    const profile = requireProfile(req);
    const parsed = z.object({ date: DATE.optional() }).safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);

    const file = stockHtml.generate({
      excludedBrands: profile.excludedBrands,
      excludedCategories: profile.excludedCategories,
      threshold: profile.threshold,
      ...(parsed.data.date ? { date: parsed.data.date } : {}),
    });
    return sendHtmlFile(res, file);
  })
);

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

router.post(
  '/send',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({
        date: DATE.optional(),
        force: z.coerce.boolean().optional(),
        profile_id: z.coerce.number().int().min(1).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);

    const result = await stockReport.sendReport({
      date: parsed.data.date,
      force: Boolean(parsed.data.force),
      profileId: parsed.data.profile_id ?? null,
      ignoreEnabled: true, // pressing the button IS the intent
    });

    const anyFailed = (result.results || []).some((r) => r.status === 'failed');
    return res.status(anyFailed && !result.sent ? 502 : 200).json({
      runDate: result.runDate,
      status: result.status,
      reason: result.reason || null,
      sent: result.sent || 0,
      failed: result.failed || 0,
      skipped: result.skipped || 0,
      syncNote: result.syncNote || null,
      results: (result.results || []).map((r) => ({
        profileId: r.profileId,
        profileName: r.profileName,
        status: r.status,
        reason: r.reason || null,
        error: r.error || null,
        recipients: (r.recipients || []).length,
        counts: r.report ? r.report.counts : null,
        attachment: r.report ? r.report.attachment.filename : null,
      })),
      lastRuns: stockReport.lastRun({}),
    });
  })
);

module.exports = router;
