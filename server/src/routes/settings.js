'use strict';

/**
 * GET  /api/settings              the UI-editable settings (and only those)
 * PUT  /api/settings              partial update — send just the keys you change
 * POST /api/settings/test-email   {to} — prove the SMTP config end to end
 *
 * Deliberately a whitelist rather than a dump of the `settings` table: that
 * table also holds the Zoho client secret and refresh token, which must never
 * reach the browser. Zoho credentials are managed by /api/zoho/*, the WhatsApp
 * session by /api/whatsapp/* — this endpoint is for plain scalar config.
 *
 * `smtp_pass` is writable but never readable: GET reports `smtp_pass_set` only.
 * Changing an smtp_* key drops the cached nodemailer transport, and changing
 * digest_send_time re-registers the cron job, so neither needs a restart.
 */

const express = require('express');
const { z } = require('zod');
const { route, asyncRoute, sendError } = require('./util');
const config = require('../config');
const email = require('../services/reminders/email');
const attribution = require('../services/attribution');
const cronJobs = require('../jobs/cron');
const logger = require('../logger');

const router = express.Router();

/**
 * The global rep visibility scope: an array of zoho_salesperson_ids, or null for
 * "every rep". Ids are constrained to a conservative charset because they are
 * spliced into IN-lists as bound parameters all over the app — nothing exotic
 * has any business being in a Zoho id.
 */
const visibleRepIdsSchema = z
  .array(z.string().trim().regex(attribution.REP_ID_RE, 'not a valid salesperson id'))
  .max(500)
  .nullable()
  .transform((ids) => (ids === null ? null : [...new Set(ids)]));

/** key → zod schema. Anything not listed here is neither read nor written. */
const EDITABLE = {
  // global rep visibility scope
  visible_rep_ids: visibleRepIdsSchema,
  // phase 1 — Zoho backfill window (0 = every invoice, however old)
  line_item_backfill_months: z.coerce.number().int().min(0).max(120),
  // phase 3 — rule windows
  dormant_months: z.coerce.number().int().min(1).max(120),
  cheque_lead_days: z.coerce.number().int().min(0).max(60),
  // phase 4 — digest schedule + overdue rule
  digest_send_time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'send time must look like HH:MM'),
  overdue_min_days: z.coerce.number().int().min(0).max(365),
  overdue_min_amount: z.coerce.number().min(0).max(1e12),
  overdue_resend_days: z.coerce.number().int().min(1).max(365),
  // phase 4 — SMTP
  smtp_host: z.string().trim().max(255),
  smtp_port: z.coerce.number().int().min(1).max(65535),
  smtp_secure: z.coerce.boolean(),
  smtp_user: z.string().trim().max(255),
  smtp_pass: z.string().max(255),
  smtp_from: z.string().trim().max(255),
};

/** Written but never returned. */
const SECRET_KEYS = new Set(['smtp_pass']);
/** Keys whose null is meaningful and must survive the read (not become ''). */
const NULLABLE_KEYS = new Set(['visible_rep_ids']);
const SMTP_KEYS = Object.keys(EDITABLE).filter((k) => k.startsWith('smtp_'));

const putSchema = z
  .object(Object.fromEntries(Object.entries(EDITABLE).map(([k, s]) => [k, s.optional()])))
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'no editable settings in the request body');

function readAll() {
  const all = config.getAllSettings();
  const out = {};
  for (const key of Object.keys(EDITABLE)) {
    if (SECRET_KEYS.has(key)) continue;
    if (NULLABLE_KEYS.has(key)) {
      out[key] = all[key] === undefined ? (config.SETTING_DEFAULTS[key] ?? null) : all[key];
      continue;
    }
    out[key] = all[key] ?? config.SETTING_DEFAULTS[key] ?? '';
  }
  out.smtp_pass_set = Boolean(all.smtp_pass || config.SMTP_PASS);
  return out;
}

function payload() {
  return {
    settings: readAll(),
    editable: Object.keys(EDITABLE).filter((k) => !SECRET_KEYS.has(k)),
    smtp: email.status(),
    cron: cronJobs.getStatus(),
    repScope: attribution.repScopeSummary(),
  };
}

router.get(
  '/',
  route((_req, res) => res.json(payload()))
);

router.put(
  '/',
  route((req, res) => {
    const parsed = putSchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);

    const updated = [];
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      config.setSetting(key, value);
      updated.push(key);
    }

    if (updated.some((k) => SMTP_KEYS.includes(k))) email.resetTransport();
    if (updated.includes('digest_send_time')) {
      const rescheduled = cronJobs.rescheduleDigest();
      if (rescheduled) logger.info(rescheduled, 'digest schedule updated');
    }

    return res.json({ ...payload(), updated });
  })
);

router.post(
  '/test-email',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({ to: z.string().trim().email('a valid recipient address is required') })
      .safeParse(req.body || {});
    if (!parsed.success) return sendError(res, parsed.error);

    try {
      const result = await email.sendTestEmail(parsed.data.to);
      return res.json(result);
    } catch (err) {
      logger.warn({ err: err.message, to: parsed.data.to }, 'test email failed');
      return res.status(err.status || 502).json({ ok: false, error: err.message });
    }
  })
);

module.exports = router;
