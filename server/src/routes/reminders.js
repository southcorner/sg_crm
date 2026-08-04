'use strict';

/**
 * GET  /api/reminders/log?date=&rep=&rule_type=&status=   paginated log
 * GET  /api/reminders/preview?rep=&date=                  composed digests, no side effects
 * POST /api/reminders/run  {date?, dry_run?, rep?}        the real thing
 * GET  /api/reminders/status                              cron + SMTP health
 *
 * `dry_run` is the same code path as the digest job right up to delivery: it
 * composes, reports what WOULD be sent (including whether the per-rep/day dedupe
 * row would block it) and writes nothing at all.
 *
 * `rules` (both on POST /run and as ?rules=a,b on the previews) picks which
 * content rules take part. OMITTING IT MEANS ALL FOUR — a bare call behaves
 * exactly as it always has, and is deliberately NOT narrowed to the
 * `rule_*_enabled` settings: those gate the scheduled digest, whereas asking
 * for a run by hand is already an explicit act. The UI always sends a list.
 *
 * A real run always honours the dedupe rows, so pressing "Send now" twice cannot
 * mail anyone twice — the UI says so before it fires.
 */

const express = require('express');
const { z } = require('zod');
const { route, asyncRoute, sendError, parsePaging, listResponse } = require('./util');
const engine = require('../services/reminders/engine');
const email = require('../services/reminders/email');
const whatsapp = require('../services/reminders/whatsapp');
const cronJobs = require('../jobs/cron');

const router = express.Router();

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must look like YYYY-MM-DD');
const RULE_TYPES = ['digest', 'overdue', 'cheque', 'dormant', 'focus', 'stock_report'];

const logSchema = z.object({
  date: DATE.optional(),
  rep: z.string().trim().max(64).optional(),
  rule_type: z.enum(RULE_TYPES).optional(),
  status: z.string().trim().max(32).optional(),
});

/**
 * Which content rules to run. OMITTED MEANS ALL FOUR — a bare `POST /run` keeps
 * doing exactly what it always did, regardless of the `rule_*_enabled` settings
 * (those gate the scheduled digest only). The UI always sends an explicit list.
 */
const rulesParam = z
  .array(z.enum(engine.RULE_KEYS))
  .min(1, 'pick at least one rule')
  .max(engine.RULE_KEYS.length)
  .optional();

/** Same thing from a query string: ?rules=cheque,overdue */
const rulesQueryParam = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    return (Array.isArray(v) ? v : [v]).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
  })
  .refine((v) => v === undefined || (v.length > 0 && v.every((r) => engine.RULE_KEYS.includes(r))), {
    message: `rules must be one or more of ${engine.RULE_KEYS.join(' | ')}`,
  });

const runSchema = z.object({
  date: DATE.optional(),
  dry_run: z
    .union([z.boolean(), z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined ? false : ['1', 'true', 'yes', true, 1].includes(typeof v === 'string' ? v.toLowerCase() : v))),
  rep: z.string().trim().max(64).optional(),
  rules: rulesParam,
});

/** Strip the rendered bodies out unless the caller asked for them. */
function digestSummary(digest, { withBody = true } = {}) {
  return {
    rep: digest.rep,
    runDate: digest.runDate,
    subject: digest.subject,
    counts: digest.counts,
    sections: digest.sections,
    focusMonth: digest.focusMonth,
    focusReason: digest.focusReason,
    dormantMonths: digest.dormantMonths,
    items: digest.items.length,
    ...(withBody ? { text: digest.text, html: digest.html } : {}),
  };
}

router.get(
  '/log',
  route((req, res) => {
    const parsed = logSchema.safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const paging = parsePaging(req.query || {});
    const q = parsed.data;

    const { rows, total, counts } = engine.listLog({
      date: q.date || null,
      rep: q.rep || null,
      ruleType: q.rule_type || null,
      status: q.status || null,
      limit: paging.limit,
      offset: paging.offset,
    });

    return res.json({
      ...listResponse(rows, total, paging),
      counts,
      dates: engine.logDates(30),
      reps: engine.digestReps().map((r) => ({ id: r.id, name: r.name })),
      ruleTypes: RULE_TYPES,
    });
  })
);

router.get(
  '/preview',
  route((req, res) => {
    const parsed = z
      .object({ date: DATE.optional(), rep: z.string().trim().max(64).optional(), rules: rulesQueryParam })
      .safeParse(req.query || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const evaluation = engine.evaluate({
      date: parsed.data.date,
      rep: parsed.data.rep || null,
      rules: parsed.data.rules ?? null,
    });
    return res.json({
      runDate: evaluation.runDate,
      settings: evaluation.settings,
      rules: evaluation.rules,
      stats: evaluation.stats,
      digests: evaluation.digests.map((d) => digestSummary(d)),
      smtp: email.status(),
    });
  })
);

router.post(
  '/run',
  asyncRoute(async (req, res) => {
    const parsed = runSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);
    const { date, dry_run: dryRun, rep, rules } = parsed.data;

    const result = await engine.run({ date, dryRun, rep: rep || null, rules: rules ?? null });
    return res.json({
      runDate: result.runDate,
      dryRun: Boolean(result.dryRun),
      channels: result.channels,
      settings: result.settings,
      rules: result.rules,
      skipped: result.skipped || null,
      stats: result.stats,
      results: result.results.map((r) => ({
        rep: { id: r.rep.id, name: r.rep.name, email: r.rep.email },
        status: r.status,
        channels: r.channels,
        counts: r.counts,
        items: r.items ?? null,
        wouldDedupe: r.wouldDedupe,
      })),
      digests: result.digests.map((d) => digestSummary(d, { withBody: Boolean(result.dryRun) })),
    });
  })
);

router.get(
  '/status',
  route((_req, res) =>
    res.json({
      cron: cronJobs.getStatus(),
      smtp: email.status(),
      whatsapp: whatsapp.getStatus({ includeQr: false }),
      digest: engine.digestStatus(),
      ruleKeys: engine.RULE_KEYS,
      automaticRules: engine.automaticRules(),
    })
  )
);

module.exports = router;
