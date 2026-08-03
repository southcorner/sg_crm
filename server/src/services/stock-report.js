'use strict';

/**
 * The daily stock-availability email.
 *
 * Audience is DEALERS, not reps — which is the whole reason quantities are
 * masked: above `stock_report_threshold` a dealer only learns "Available", and
 * only genuinely low stock shows an exact number (that is the number worth
 * acting on). The rule applies identically to a model's total and to each of
 * its colour rows, and the boundary is inclusive: with a threshold of 25,
 * exactly 25 prints "25" and 26 prints "Available".
 *
 * Structure: brand (brands-table order, Unbranded last) → category → model,
 * with colour sub-rows under each model. Grouping lives in services/stock.js.
 *
 * Delivery is one Bcc'd mail so dealers never see each other's addresses, and
 * the once-per-day guard is the same `reminders_log` pattern the rep digest
 * uses: a row is written BEFORE the send, so a crash-restart cannot re-send.
 * `rule_type='stock_report'`, `entity_id` = the run date.
 */

const { getDb } = require('../db/connection');
const config = require('../config');
const logger = require('../logger');
const { todayIso } = require('./attribution');
const stock = require('./stock');
const email = require('./reminders/email');

const RULE_TYPE = 'stock_report';
const ENTITY_TYPE = 'report';
const DEFAULT_TIME = '08:30';
const DEFAULT_THRESHOLD = 25;
const MASK_LABEL = 'Available';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      // a comma-separated string is a reasonable thing for a human to have typed
      return value.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function reportTime() {
  const raw = String(config.getSetting('stock_report_time', DEFAULT_TIME) || DEFAULT_TIME).trim();
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : DEFAULT_TIME;
}

/** Everything the composer and the job read, resolved once. */
function reportSettings() {
  const threshold = Math.trunc(Number(config.getSetting('stock_report_threshold', DEFAULT_THRESHOLD)));
  return {
    enabled: Boolean(config.getSetting('stock_report_enabled', false)),
    time: reportTime(),
    recipients: asArray(config.getSetting('stock_report_recipients', [])).map((r) => String(r).trim()).filter(Boolean),
    threshold: Number.isFinite(threshold) && threshold >= 1 ? Math.min(threshold, 10000) : DEFAULT_THRESHOLD,
    excludedBrands: asArray(config.getSetting('stock_report_excluded_brands', [])).map(Number).filter((n) => Number.isFinite(n)),
    excludedCategories: asArray(config.getSetting('stock_report_excluded_categories', [])).map(String),
    syncFirst: Boolean(config.getSetting('stock_report_sync_first', true)),
  };
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

/** '2026-08-05' → '05 Aug 2026' (fixed, locale-independent). */
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d} ${MONTHS[Number(m) - 1] || m} ${y}`;
}

/** Stock can be fractional (line sold by weight) — never print 4038.0000001. */
function formatQty(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v) ? String(v) : String(v);
}

/**
 * THE masking rule. Above the threshold a dealer sees only that we have it;
 * at or below it they see exactly how little is left.
 */
function maskQty(qty, threshold) {
  const n = Number(qty) || 0;
  return n > threshold ? MASK_LABEL : formatQty(n);
}

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

const CSS = {
  body: 'margin:0;padding:24px;background:#f4f5f7;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933;',
  card: 'max-width:680px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px;border:1px solid #e2e6ea;',
  h1: 'margin:0 0 4px;font-size:19px;font-weight:600;color:#12263f;',
  sub: 'margin:0 0 20px;font-size:13px;color:#6b7785;',
  brand: 'margin:26px 0 6px;font-size:16px;font-weight:700;color:#12263f;border-bottom:2px solid #12263f;padding-bottom:4px;',
  cat: 'margin:16px 0 6px;font-size:13px;font-weight:600;color:#52606d;text-transform:uppercase;letter-spacing:.04em;',
  table: 'width:100%;border-collapse:collapse;font-size:13px;',
  th: 'text-align:left;padding:6px 8px;background:#f4f5f7;color:#52606d;font-weight:600;border-bottom:1px solid #e2e6ea;',
  tdModel: 'padding:6px 8px;border-bottom:1px solid #eef1f4;font-weight:600;',
  tdColor: 'padding:3px 8px 3px 24px;border-bottom:1px solid #f6f8fa;color:#6b7785;',
  right: 'text-align:right;white-space:nowrap;',
  avail: 'text-align:right;white-space:nowrap;color:#1a7f4b;font-weight:600;',
  low: 'text-align:right;white-space:nowrap;color:#b4531f;font-weight:600;',
  foot: 'margin:26px 0 0;padding-top:12px;border-top:1px solid #eef1f4;font-size:11px;color:#9aa5b1;line-height:1.6;',
};

function qtyStyle(qty, threshold, base) {
  return Number(qty) > threshold ? CSS.avail : base;
}

/** When were items last pulled from Zoho? Drives the staleness footer. */
function itemsSyncState({ db = getDb() } = {}) {
  const row = db.prepare("SELECT last_run_at, last_status FROM sync_state WHERE entity = 'items'").get();
  return { lastRunAt: (row && row.last_run_at) || null, lastStatus: (row && row.last_status) || null };
}

/**
 * Build the whole email.
 *
 * @param {object}  opts
 * @param {string}  [opts.date]     run date (YYYY-MM-DD)
 * @param {object}  [opts.settings] override the stored settings (preview)
 * @param {object}  [opts.syncNote] {attempted, ok, error} from a pre-send sync
 */
function compose({ date, now = new Date(), settings: override = null, syncNote = null, db = getDb() } = {}) {
  const runDate = date || todayIso(now);
  const settings = { ...reportSettings(), ...(override || {}) };
  const tree = stock.buildStock({
    excludedBrands: settings.excludedBrands,
    excludedCategories: settings.excludedCategories,
    db,
  });
  const sync = itemsSyncState({ db });

  const subject = `Stock availability — ${runDate}`;
  const threshold = settings.threshold;

  // --- html ---------------------------------------------------------------
  const html = [];
  html.push(`<div style="${CSS.body}"><div style="${CSS.card}">`);
  html.push(`<h1 style="${CSS.h1}">Stock availability</h1>`);
  html.push(
    `<p style="${CSS.sub}">${esc(fmtDate(runDate))} · ${tree.counts.models} model(s) in stock across ` +
      `${tree.counts.brands} brand(s).</p>`
  );

  if (!tree.brands.length) {
    html.push(`<p style="${CSS.sub}">Nothing is in stock right now.</p>`);
  }

  for (const brand of tree.brands) {
    html.push(`<h2 style="${CSS.brand}">${esc(brand.name)}</h2>`);
    for (const cat of brand.categories) {
      html.push(`<h3 style="${CSS.cat}">${esc(cat.name)}</h3>`);
      const rows = [];
      for (const model of cat.models) {
        rows.push(
          `<tr><td style="${CSS.tdModel}">${esc(model.model)}</td>` +
            `<td style="${qtyStyle(model.total, threshold, CSS.low)}">${esc(maskQty(model.total, threshold))}</td></tr>`
        );
        // a single unspecified colour adds nothing the model row didn't say
        const showColors = model.colors.length > 1 || (model.colors[0] && model.colors[0].color !== '(unspecified)');
        if (showColors) {
          for (const c of model.colors) {
            rows.push(
              `<tr><td style="${CSS.tdColor}">${esc(c.color)}</td>` +
                `<td style="${qtyStyle(c.afs, threshold, CSS.tdColor + CSS.right)}">${esc(maskQty(c.afs, threshold))}</td></tr>`
            );
          }
        }
      }
      html.push(
        `<table style="${CSS.table}"><thead><tr>` +
          `<th style="${CSS.th}">Model</th><th style="${CSS.th}${CSS.right}">Stock</th>` +
          `</tr></thead><tbody>${rows.join('')}</tbody></table>`
      );
    }
  }

  const footNotes = [
    `Quantities above ${threshold} are shown as “${MASK_LABEL}”.`,
    sync.lastRunAt ? `Stock last synced from Zoho Books: ${sync.lastRunAt} UTC.` : 'Stock has never been synced from Zoho Books.',
  ];
  if (syncNote && syncNote.attempted && !syncNote.ok) {
    footNotes.push(`Today's refresh did not complete (${syncNote.error || 'unknown error'}) — these figures may be out of date.`);
  }
  footNotes.push('Sent automatically by SG CRM. Please do not reply to this address.');
  html.push(`<p style="${CSS.foot}">${footNotes.map(esc).join('<br>')}</p>`);
  html.push('</div></div>');

  // --- plain text ---------------------------------------------------------
  const text = [];
  text.push(`STOCK AVAILABILITY — ${fmtDate(runDate)}`);
  text.push(`${tree.counts.models} model(s) in stock across ${tree.counts.brands} brand(s).`);
  if (!tree.brands.length) text.push('', 'Nothing is in stock right now.');
  for (const brand of tree.brands) {
    text.push('', `== ${brand.name.toUpperCase()} ==`);
    for (const cat of brand.categories) {
      text.push(`-- ${cat.name} --`);
      for (const model of cat.models) {
        text.push(`  ${model.model}: ${maskQty(model.total, threshold)}`);
        const showColors = model.colors.length > 1 || (model.colors[0] && model.colors[0].color !== '(unspecified)');
        if (showColors) {
          for (const c of model.colors) text.push(`      ${c.color}: ${maskQty(c.afs, threshold)}`);
        }
      }
    }
  }
  text.push('', ...footNotes);

  return {
    runDate,
    subject,
    html: html.join(''),
    text: text.join('\n'),
    counts: tree.counts,
    threshold,
    recipients: settings.recipients,
    excluded: tree.excluded,
    sync,
    syncNote,
    brands: tree.brands.map((b) => ({
      id: b.id,
      name: b.name,
      models: b.models,
      items: b.items,
      categories: b.categories.map((c) => ({ name: c.name, models: c.models.length })),
    })),
  };
}

// ---------------------------------------------------------------------------
// the once-per-day guard
// ---------------------------------------------------------------------------

function insertLog({ runDate, status, detail, db = getDb() }) {
  const info = db
    .prepare(
      `INSERT INTO reminders_log (run_date, rule_type, entity_type, entity_id, salesperson_id, channel, status, detail)
       VALUES (@run_date, @rule_type, @entity_type, @entity_id, NULL, 'email', @status, @detail)`
    )
    .run({
      run_date: runDate,
      rule_type: RULE_TYPE,
      entity_type: ENTITY_TYPE,
      entity_id: runDate,
      status,
      detail: detail === null || detail === undefined ? null : JSON.stringify(detail),
    });
  return Number(info.lastInsertRowid);
}

function updateLog(id, status, detail, { db = getDb() } = {}) {
  db.prepare('UPDATE reminders_log SET status = ?, detail = ? WHERE id = ?').run(
    status,
    detail === null || detail === undefined ? null : JSON.stringify(detail),
    id
  );
}

/** Any non-dedupe row for the date means today's report is done. */
function alreadySentToday(runDate, { db = getDb() } = {}) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS hit FROM reminders_log
          WHERE rule_type = ? AND entity_id = ? AND status <> 'skipped_dedupe'
          LIMIT 1`
      )
      .get(RULE_TYPE, runDate)
  );
}

/** Latest outcome per day — the Settings tab and the log UI both want this. */
function lastRun({ db = getDb(), limit = 7 } = {}) {
  return db
    .prepare(
      `SELECT id, run_date, status, detail, created_at FROM reminders_log
        WHERE rule_type = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(RULE_TYPE, limit)
    .map((r) => {
      let detail = null;
      try {
        detail = r.detail ? JSON.parse(r.detail) : null;
      } catch (_err) {
        detail = { text: r.detail };
      }
      return { ...r, detail };
    });
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

/** 'HH:MM' → minutes since midnight. */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Should a just-booted server fire today's report right now?
 *
 * The admin starts the machine in the morning; if that happens after the
 * scheduled time, cron alone would silently skip the day. True only when the
 * report is on, the send time has passed, and today has not gone out.
 */
function shouldCatchUp({ now = new Date(), db = getDb() } = {}) {
  const settings = reportSettings();
  if (!settings.enabled) return { catchUp: false, reason: 'disabled' };
  if (!settings.recipients.length) return { catchUp: false, reason: 'no recipients' };

  const runDate = todayIso(now);
  if (alreadySentToday(runDate, { db })) return { catchUp: false, reason: 'already sent today', runDate };

  const due = minutesOf(settings.time);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (due === null || nowMinutes < due) {
    return { catchUp: false, reason: 'send time has not passed yet', runDate, time: settings.time };
  }
  return { catchUp: true, reason: 'missed today’s scheduled send', runDate, time: settings.time };
}

/** Refresh items from Zoho, tolerating every failure — stale beats nothing. */
async function refreshItems() {
  const note = { attempted: false, ok: false, error: null, skipped: null };
  try {
    const auth = require('../zoho/auth');
    const sync = require('../zoho/sync');
    if (!auth.isConnected()) {
      note.skipped = 'zoho not connected';
      return note;
    }
    if (sync.isRunning()) {
      note.skipped = 'a sync is already running';
      return note;
    }
    note.attempted = true;
    const result = await sync.runSync({ entities: ['items'] });
    note.ok = Boolean(result && result.ok !== false);
    if (!note.ok) note.error = (result.errors && result.errors[0] && result.errors[0].error) || 'sync reported errors';
  } catch (err) {
    note.attempted = true;
    note.ok = false;
    note.error = err.message;
    logger.warn({ err: err.message }, 'stock report: item refresh failed, continuing with stored data');
  }
  return note;
}

/**
 * Compose and send today's report.
 *
 * @param {object}   opts
 * @param {boolean}  [opts.force]      ignore the once-per-day guard
 * @param {boolean}  [opts.ignoreEnabled] send even when the schedule is off (manual "Send now")
 * @param {function} [opts.send]       injected transport (tests)
 */
async function sendReport({
  date,
  now = new Date(),
  force = false,
  ignoreEnabled = false,
  send = null,
  db = getDb(),
} = {}) {
  const runDate = date || todayIso(now);
  const settings = reportSettings();

  if (!settings.enabled && !ignoreEnabled) {
    logger.debug('stock report skipped — disabled');
    return { runDate, status: 'skipped', reason: 'disabled', sent: false };
  }
  if (!settings.recipients.length) {
    logger.warn('stock report skipped — no recipients configured in Settings → Stock Report');
    return { runDate, status: 'skipped', reason: 'no recipients', sent: false };
  }
  if (!force && alreadySentToday(runDate, { db })) {
    logger.info({ runDate }, 'stock report skipped — already sent today');
    insertLog({ runDate, status: 'skipped_dedupe', detail: { reason: 'already sent today' }, db });
    return { runDate, status: 'skipped_dedupe', reason: 'already sent today', sent: false };
  }

  const syncNote = settings.syncFirst ? await refreshItems() : { attempted: false, ok: false, skipped: 'sync_first off' };
  const report = compose({ date: runDate, now, syncNote, db });

  // written BEFORE the send: a crash here leaves a 'pending' row, which the
  // guard still treats as "today is done" rather than mailing dealers twice
  const logId = insertLog({
    runDate,
    status: 'pending',
    detail: { subject: report.subject, recipients: settings.recipients.length, counts: report.counts },
    db,
  });

  try {
    const sender = send || ((r) => email.sendBcc(settings.recipients, r.subject, r.html, r.text));
    const info = await sender(report, settings.recipients);
    updateLog(
      logId,
      'sent',
      {
        subject: report.subject,
        recipients: settings.recipients.length,
        counts: report.counts,
        threshold: report.threshold,
        messageId: (info && info.messageId) || null,
        syncNote,
      },
      { db }
    );
    logger.info({ runDate, recipients: settings.recipients.length, ...report.counts }, 'stock report sent');
    return { runDate, status: 'sent', sent: true, report, recipients: settings.recipients, syncNote, logId };
  } catch (err) {
    updateLog(logId, 'failed', { subject: report.subject, error: err.message, syncNote }, { db });
    logger.error({ err: err.message, runDate }, 'stock report send failed');
    return { runDate, status: 'failed', sent: false, error: err.message, syncNote, logId };
  }
}

/** The cron/boot entry point — same flow, never throws at the caller. */
async function runStockReportJob({ now = new Date(), force = false } = {}) {
  const result = await sendReport({ now, force });
  return { runDate: result.runDate, status: result.status, reason: result.reason || null, counts: result.report ? result.report.counts : null };
}

module.exports = {
  RULE_TYPE,
  ENTITY_TYPE,
  DEFAULT_TIME,
  DEFAULT_THRESHOLD,
  MASK_LABEL,
  asArray,
  reportTime,
  reportSettings,
  fmtDate,
  formatQty,
  maskQty,
  itemsSyncState,
  compose,
  alreadySentToday,
  lastRun,
  minutesOf,
  shouldCatchUp,
  refreshItems,
  sendReport,
  runStockReportJob,
};
