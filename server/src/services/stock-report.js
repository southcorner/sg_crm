'use strict';

/**
 * The daily stock-availability email, one per recipient PROFILE.
 *
 * Audience is DEALERS, not reps — which is the whole reason quantities are
 * masked: above a profile's threshold a dealer only learns "Available", and
 * only genuinely low stock shows an exact number (that is the number worth
 * acting on). The boundary is inclusive: with a threshold of 25, exactly 25
 * prints "25" and 26 prints "Available".
 *
 * A PROFILE is {name, recipients, excluded brands, excluded categories,
 * threshold, enabled} — see migration 003. The nightly job walks every enabled
 * profile that has recipients and sends each one its own tailored mail, so a
 * Racket-only dealer group and an everything-but-Unbranded group can be served
 * by the same schedule. The pre-profile global settings were migrated into a
 * "Default" profile; the only settings left are the master switch, the send
 * time and sync_first.
 *
 * THE MAIL: the searchable offline HTML browser (services/stock-html.js) is now
 * the artifact — it is attached as `Stock <date>.html`. The body is deliberately
 * a short per-brand summary pointing at it, because the old full catalogue body
 * ran to 340 KB of tables nobody scrolled.
 *
 * The once-per-day guard is the `reminders_log` pattern the rep digest uses,
 * now keyed PER PROFILE: `rule_type='stock_report'`,
 * `entity_id = '<profile id>:<run date>'`, and the row is written BEFORE the
 * send so a crash-restart cannot mail a dealer twice.
 */

const { getDb } = require('../db/connection');
const config = require('../config');
const logger = require('../logger');
const { todayIso } = require('./attribution');
const stock = require('./stock');
const stockHtml = require('./stock-html');
const email = require('./reminders/email');

const RULE_TYPE = 'stock_report';
const ENTITY_TYPE = 'profile';
const DEFAULT_TIME = '08:30';
const DEFAULT_THRESHOLD = 25;
const MASK_LABEL = stock.MASK_LABEL;
const MAX_THRESHOLD = 10000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// global settings (what survived the move to profiles)
// ---------------------------------------------------------------------------

function reportTime() {
  const raw = String(config.getSetting('stock_report_time', DEFAULT_TIME) || DEFAULT_TIME).trim();
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : DEFAULT_TIME;
}

/**
 * Only three knobs are global now. Recipients, exclusions and the threshold
 * belong to a profile — the legacy settings keys of the same name were migrated
 * into the "Default" profile and are no longer read by anything.
 */
function reportSettings() {
  return {
    enabled: Boolean(config.getSetting('stock_report_enabled', false)),
    time: reportTime(),
    syncFirst: Boolean(config.getSetting('stock_report_sync_first', true)),
  };
}

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

function parseJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (_err) {
    return fallback;
  }
}

function clampThreshold(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_THRESHOLD;
  return Math.min(n, MAX_THRESHOLD);
}

/** Attachments beyond this lose their images rather than the send. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function maxAttachmentBytes() {
  const n = Math.trunc(Number(config.getSetting('stock_max_attachment_bytes', DEFAULT_MAX_ATTACHMENT_BYTES)));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ATTACHMENT_BYTES;
}

function rowToProfile(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    recipients: parseJsonArray(row.recipients_json).map((r) => String(r).trim()).filter(Boolean),
    excludedBrands: parseJsonArray(row.excluded_brands_json).map(Number).filter((n) => Number.isFinite(n)),
    excludedCategories: parseJsonArray(row.excluded_categories_json).map(String),
    threshold: clampThreshold(row.threshold),
    includeImages: row.include_images === undefined || row.include_images === null ? true : Boolean(row.include_images),
    enabled: Boolean(row.enabled),
    sortOrder: Number(row.sort_order || 0),
    note: row.note || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listProfiles({ db = getDb(), enabledOnly = false } = {}) {
  return db
    .prepare(
      `SELECT * FROM stock_report_profiles
        ${enabledOnly ? 'WHERE enabled = 1' : ''}
        ORDER BY sort_order ASC, id ASC`
    )
    .all()
    .map(rowToProfile);
}

function getProfile(id, { db = getDb() } = {}) {
  return rowToProfile(db.prepare('SELECT * FROM stock_report_profiles WHERE id = ?').get(Number(id)));
}

/** The profiles the nightly job will actually mail. */
function sendableProfiles({ db = getDb() } = {}) {
  return listProfiles({ db, enabledOnly: true }).filter((p) => p.recipients.length > 0);
}

function createProfile(input, { db = getDb() } = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw httpError(400, 'a profile needs a name');

  const info = db
    .prepare(
      `INSERT INTO stock_report_profiles
         (name, recipients_json, excluded_brands_json, excluded_categories_json, threshold, enabled, include_images, sort_order, note)
       VALUES (@name, @recipients, @brands, @cats, @threshold, @enabled, @include_images, @sort_order, @note)`
    )
    .run({
      name,
      recipients: JSON.stringify(parseJsonArray(input.recipients).map((r) => String(r).trim()).filter(Boolean)),
      brands: JSON.stringify(parseJsonArray(input.excludedBrands).map(Number).filter((n) => Number.isFinite(n))),
      cats: JSON.stringify(parseJsonArray(input.excludedCategories).map(String)),
      threshold: clampThreshold(input.threshold ?? DEFAULT_THRESHOLD),
      enabled: input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
      include_images: input.includeImages === undefined ? 1 : input.includeImages ? 1 : 0,
      sort_order: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : nextSortOrder({ db }),
      note: input.note ? String(input.note) : null,
    });
  return getProfile(Number(info.lastInsertRowid), { db });
}

function nextSortOrder({ db = getDb() } = {}) {
  const row = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM stock_report_profiles').get();
  return Number(row.next || 0);
}

function updateProfile(id, patch, { db = getDb() } = {}) {
  const existing = getProfile(id, { db });
  if (!existing) throw httpError(404, 'profile not found');

  const next = {
    name: patch.name !== undefined ? String(patch.name).trim() : existing.name,
    recipients: patch.recipients !== undefined ? parseJsonArray(patch.recipients).map((r) => String(r).trim()).filter(Boolean) : existing.recipients,
    excludedBrands: patch.excludedBrands !== undefined ? parseJsonArray(patch.excludedBrands).map(Number).filter((n) => Number.isFinite(n)) : existing.excludedBrands,
    excludedCategories: patch.excludedCategories !== undefined ? parseJsonArray(patch.excludedCategories).map(String) : existing.excludedCategories,
    threshold: patch.threshold !== undefined ? clampThreshold(patch.threshold) : existing.threshold,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled ? 1 : 0,
    includeImages: patch.includeImages !== undefined ? (patch.includeImages ? 1 : 0) : existing.includeImages ? 1 : 0,
    sortOrder: patch.sortOrder !== undefined ? Number(patch.sortOrder) : existing.sortOrder,
    note: patch.note !== undefined ? (patch.note ? String(patch.note) : null) : existing.note,
  };
  if (!next.name) throw httpError(400, 'a profile needs a name');

  db.prepare(
    `UPDATE stock_report_profiles
        SET name = @name, recipients_json = @recipients, excluded_brands_json = @brands,
            excluded_categories_json = @cats, threshold = @threshold, enabled = @enabled,
            include_images = @include_images, sort_order = @sort_order, note = @note,
            updated_at = datetime('now')
      WHERE id = @id`
  ).run({
    id: Number(id),
    name: next.name,
    recipients: JSON.stringify(next.recipients),
    brands: JSON.stringify(next.excludedBrands),
    cats: JSON.stringify(next.excludedCategories),
    threshold: next.threshold,
    enabled: next.enabled,
    include_images: next.includeImages,
    sort_order: next.sortOrder,
    note: next.note,
  });
  return getProfile(id, { db });
}

function deleteProfile(id, { db = getDb() } = {}) {
  const info = db.prepare('DELETE FROM stock_report_profiles WHERE id = ?').run(Number(id));
  if (!info.changes) throw httpError(404, 'profile not found');
  return { deleted: Number(id) };
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

const formatQty = stock.formatQty;
const maskQty = stock.maskQty;

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
  card: 'max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px;border:1px solid #e2e6ea;',
  h1: 'margin:0 0 4px;font-size:19px;font-weight:600;color:#12263f;',
  sub: 'margin:0 0 18px;font-size:13px;color:#6b7785;',
  callout: 'margin:0 0 20px;padding:12px 14px;background:#eef4fd;border:1px solid #cfe0f8;border-radius:8px;font-size:13.5px;color:#12263f;line-height:1.55;',
  table: 'width:100%;border-collapse:collapse;font-size:13px;',
  th: 'text-align:left;padding:7px 8px;background:#f4f5f7;color:#52606d;font-weight:600;border-bottom:1px solid #e2e6ea;',
  td: 'padding:7px 8px;border-bottom:1px solid #eef1f4;vertical-align:top;',
  tdBrand: 'padding:7px 8px;border-bottom:1px solid #eef1f4;font-weight:600;',
  right: 'text-align:right;white-space:nowrap;',
  avail: 'text-align:right;white-space:nowrap;color:#1a7f4b;font-weight:600;',
  low: 'text-align:right;white-space:nowrap;color:#b4531f;font-weight:600;',
  cats: 'font-size:11.5px;color:#9aa5b1;',
  foot: 'margin:26px 0 0;padding-top:12px;border-top:1px solid #eef1f4;font-size:11px;color:#9aa5b1;line-height:1.6;',
};

/** When were items last pulled from Zoho? Drives the staleness footer. */
function itemsSyncState({ db = getDb() } = {}) {
  const row = db.prepare("SELECT last_run_at, last_status FROM sync_state WHERE entity = 'items'").get();
  return { lastRunAt: (row && row.last_run_at) || null, lastStatus: (row && row.last_status) || null };
}

/**
 * Compose one profile's mail: a short per-brand summary body plus the
 * searchable HTML browser as an attachment, both built from the SAME
 * exclusions and threshold so the two can never disagree.
 *
 * @param {object} opts
 * @param {object} opts.profile   a profile row (or any {threshold, excluded*} shape)
 * @param {string} [opts.date]    run date (YYYY-MM-DD)
 * @param {object} [opts.syncNote] {attempted, ok, error} from a pre-send sync
 */
function compose({ profile, date, now = new Date(), syncNote = null, db = getDb() } = {}) {
  const runDate = date || todayIso(now);
  const threshold = clampThreshold(profile ? profile.threshold : DEFAULT_THRESHOLD);
  const excludedBrands = (profile && profile.excludedBrands) || [];
  const excludedCategories = (profile && profile.excludedCategories) || [];

  const tree = stock.buildStock({ excludedBrands, excludedCategories, db });
  const sync = itemsSyncState({ db });
  // Photos make the file far more useful and far bigger. Generate with them,
  // then check: an attachment past MAX_ATTACHMENT_BYTES gets bounced by some
  // mail servers and is miserable on a phone, so it is regenerated without
  // images rather than sent broken or not at all.
  const wantsImages = profile ? profile.includeImages !== false : true;
  let file = stockHtml.generate({
    excludedBrands,
    excludedCategories,
    threshold,
    date: runDate,
    includeImages: wantsImages,
    db,
  });
  let imagesDropped = null;
  const size = Buffer.byteLength(file.html, 'utf8');
  if (wantsImages && size > maxAttachmentBytes()) {
    logger.warn(
      { profile: profile && profile.name, bytes: size, cap: maxAttachmentBytes() },
      'stock file too large with images — regenerating without them'
    );
    file = stockHtml.generate({
      excludedBrands,
      excludedCategories,
      threshold,
      date: runDate,
      includeImages: false,
      db,
    });
    imagesDropped = { reason: 'size', bytesWithImages: size, cap: maxAttachmentBytes() };
  }

  const subject = `Stock availability — ${runDate}`;

  const footNotes = [
    `Quantities above ${threshold} are shown as “${MASK_LABEL}”.`,
    sync.lastRunAt ? `Stock last synced from Zoho Books: ${sync.lastRunAt} UTC.` : 'Stock has never been synced from Zoho Books.',
  ];
  if (syncNote && syncNote.attempted && !syncNote.ok) {
    footNotes.push(`Today's refresh did not complete (${syncNote.error || 'unknown error'}) — these figures may be out of date.`);
  }
  footNotes.push('Sent automatically by SG CRM. Please do not reply to this address.');

  // --- html body: a summary that fits on a phone screen -------------------
  const html = [];
  html.push(`<div style="${CSS.body}"><div style="${CSS.card}">`);
  html.push(`<h1 style="${CSS.h1}">Stock availability</h1>`);
  html.push(
    `<p style="${CSS.sub}">${esc(fmtDate(runDate))} · ${tree.counts.models} model(s) in stock across ` +
      `${tree.counts.brands} brand(s).</p>`
  );
  html.push(
    `<p style="${CSS.callout}"><strong>Open the attached file — <em>${esc(file.filename)}</em> — to search the full list.</strong><br>` +
      'It opens in any phone browser, works offline, and lets you search by model, colour or SKU and filter by brand and category.</p>'
  );

  if (!tree.brands.length) {
    html.push(`<p style="${CSS.sub}">Nothing is in stock right now.</p>`);
  } else {
    const rows = tree.brands
      .map((brand) => {
        const cats = brand.categories.map((c) => `${c.name} (${c.models.length})`).join(' · ');
        const qty = maskQty(brand.total, threshold);
        const style = Number(brand.total) > threshold ? CSS.avail : CSS.low;
        return (
          `<tr><td style="${CSS.tdBrand}">${esc(brand.name)}<div style="${CSS.cats}">${esc(cats)}</div></td>` +
          `<td style="${CSS.td}${CSS.right}">${brand.models}</td>` +
          `<td style="${style}">${esc(qty)}</td></tr>`
        );
      })
      .join('');
    html.push(
      `<table style="${CSS.table}"><thead><tr>` +
        `<th style="${CSS.th}">Brand</th>` +
        `<th style="${CSS.th}${CSS.right}">Models</th>` +
        `<th style="${CSS.th}${CSS.right}">Stock</th>` +
        `</tr></thead><tbody>${rows}</tbody></table>`
    );
  }

  html.push(`<p style="${CSS.foot}">${footNotes.map(esc).join('<br>')}</p>`);
  html.push('</div></div>');

  // --- plain text ---------------------------------------------------------
  const text = [];
  text.push(`STOCK AVAILABILITY — ${fmtDate(runDate)}`);
  text.push(`${tree.counts.models} model(s) in stock across ${tree.counts.brands} brand(s).`);
  text.push('');
  text.push(`Open the attached file — ${file.filename} — to search the full list.`);
  text.push('It opens in any phone browser, works offline, and lets you search by');
  text.push('model, colour or SKU and filter by brand and category.');
  if (!tree.brands.length) {
    text.push('', 'Nothing is in stock right now.');
  } else {
    text.push('');
    for (const brand of tree.brands) {
      text.push(`${brand.name}: ${brand.models} model(s) · ${maskQty(brand.total, threshold)}`);
      text.push(`   ${brand.categories.map((c) => `${c.name} (${c.models.length})`).join(' · ')}`);
    }
  }
  text.push('', ...footNotes);

  return {
    runDate,
    profileId: profile ? profile.id ?? null : null,
    profileName: profile ? profile.name ?? null : null,
    subject,
    html: html.join(''),
    text: text.join('\n'),
    attachment: {
      filename: file.filename,
      content: file.html,
      contentType: 'text/html; charset=utf-8',
    },
    counts: { ...tree.counts, fileBytes: Buffer.byteLength(file.html, 'utf8'), images: file.images },
    includeImages: wantsImages && !imagesDropped,
    imagesDropped,
    threshold,
    recipients: (profile && profile.recipients) || [],
    excluded: tree.excluded,
    sync,
    syncNote,
    file: {
      filename: file.filename,
      brands: file.brands,
      categories: file.categories,
      rows: file.counts.rows,
      images: file.images,
    },
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
// the once-per-day guard (per profile)
// ---------------------------------------------------------------------------

/** The reminders_log entity key for a profile's daily send. */
function guardKey(profileId, runDate) {
  return `${profileId}:${runDate}`;
}

function insertLog({ runDate, profileId, status, detail, db = getDb() }) {
  const info = db
    .prepare(
      `INSERT INTO reminders_log (run_date, rule_type, entity_type, entity_id, salesperson_id, channel, status, detail)
       VALUES (@run_date, @rule_type, @entity_type, @entity_id, NULL, 'email', @status, @detail)`
    )
    .run({
      run_date: runDate,
      rule_type: RULE_TYPE,
      entity_type: ENTITY_TYPE,
      entity_id: guardKey(profileId, runDate),
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

/** Any non-dedupe row for this profile+date means its report is done. */
function alreadySentToday(profileId, runDate, { db = getDb() } = {}) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS hit FROM reminders_log
          WHERE rule_type = ? AND entity_id = ? AND status <> 'skipped_dedupe'
          LIMIT 1`
      )
      .get(RULE_TYPE, guardKey(profileId, runDate))
  );
}

/** Recent outcomes — the Settings tab and the Reminders log both want these. */
function lastRun({ db = getDb(), limit = 20, profileId = null } = {}) {
  const rows = profileId
    ? db
        .prepare(
          `SELECT id, run_date, entity_id, status, detail, created_at FROM reminders_log
            WHERE rule_type = ? AND entity_id LIKE ? ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .all(RULE_TYPE, `${profileId}:%`, limit)
    : db
        .prepare(
          `SELECT id, run_date, entity_id, status, detail, created_at FROM reminders_log
            WHERE rule_type = ? ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .all(RULE_TYPE, limit);

  return rows.map((r) => {
    let detail = null;
    try {
      detail = r.detail ? JSON.parse(r.detail) : null;
    } catch (_err) {
      detail = { text: r.detail };
    }
    return { ...r, detail, profileId: Number(String(r.entity_id || '').split(':')[0]) || null };
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
 * Should a just-booted server fire today's reports right now?
 *
 * The admin starts the machine in the morning; if that happens after the
 * scheduled time, cron alone would silently skip the day. True only when the
 * feature is on, at least one sendable profile has not gone out today, and the
 * send time has passed.
 */
function shouldCatchUp({ now = new Date(), db = getDb() } = {}) {
  const settings = reportSettings();
  if (!settings.enabled) return { catchUp: false, reason: 'disabled' };

  const profiles = sendableProfiles({ db });
  if (!profiles.length) return { catchUp: false, reason: 'no profiles with recipients' };

  const runDate = todayIso(now);
  const pending = profiles.filter((p) => !alreadySentToday(p.id, runDate, { db }));
  if (!pending.length) return { catchUp: false, reason: 'already sent today', runDate };

  const due = minutesOf(settings.time);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (due === null || nowMinutes < due) {
    return { catchUp: false, reason: 'send time has not passed yet', runDate, time: settings.time };
  }
  return { catchUp: true, reason: 'missed today’s scheduled send', runDate, time: settings.time, pending: pending.length };
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
 * Send one profile's report.
 *
 * @param {object}   opts
 * @param {object}   opts.profile
 * @param {boolean}  [opts.force]  ignore that profile's once-per-day guard
 * @param {function} [opts.send]   injected transport (tests)
 */
async function sendProfile({ profile, date, now = new Date(), force = false, send = null, syncNote = null, db = getDb() } = {}) {
  const runDate = date || todayIso(now);
  const base = { runDate, profileId: profile.id, profileName: profile.name };

  if (!profile.recipients.length) {
    logger.warn({ profile: profile.name }, 'stock report profile skipped — no recipients');
    return { ...base, status: 'skipped', reason: 'no recipients', sent: false };
  }
  if (!force && alreadySentToday(profile.id, runDate, { db })) {
    logger.info({ profile: profile.name, runDate }, 'stock report profile skipped — already sent today');
    insertLog({ runDate, profileId: profile.id, status: 'skipped_dedupe', detail: { profile: profile.name, reason: 'already sent today' }, db });
    return { ...base, status: 'skipped_dedupe', reason: 'already sent today', sent: false };
  }

  const report = compose({ profile, date: runDate, now, syncNote, db });

  // written BEFORE the send: a crash here leaves a 'pending' row, which the
  // guard still treats as "this profile is done" rather than mailing twice
  const logId = insertLog({
    runDate,
    profileId: profile.id,
    status: 'pending',
    detail: { profile: profile.name, subject: report.subject, recipients: profile.recipients.length, counts: report.counts },
    db,
  });

  try {
    const sender =
      send ||
      ((r, recipients) => email.sendBcc(recipients, r.subject, r.html, r.text, [r.attachment]));
    const info = await sender(report, profile.recipients, profile);
    updateLog(
      logId,
      'sent',
      {
        profile: profile.name,
        subject: report.subject,
        recipients: profile.recipients.length,
        counts: report.counts,
        threshold: report.threshold,
        attachment: report.attachment.filename,
        messageId: (info && info.messageId) || null,
        syncNote,
      },
      { db }
    );
    logger.info(
      { profile: profile.name, runDate, recipients: profile.recipients.length, models: report.counts.models },
      'stock report sent'
    );
    return { ...base, status: 'sent', sent: true, report, recipients: profile.recipients, syncNote, logId };
  } catch (err) {
    updateLog(logId, 'failed', { profile: profile.name, subject: report.subject, error: err.message, syncNote }, { db });
    logger.error({ err: err.message, profile: profile.name, runDate }, 'stock report send failed');
    return { ...base, status: 'failed', sent: false, error: err.message, syncNote, logId };
  }
}

/**
 * The daily run: every enabled profile with recipients, each independently
 * guarded so one dealer group's SMTP failure cannot cost another its report.
 *
 * @param {object}  opts
 * @param {number}  [opts.profileId]     restrict to one profile (manual send)
 * @param {boolean} [opts.ignoreEnabled] send even when the master switch is off
 */
async function sendReport({
  date,
  now = new Date(),
  force = false,
  ignoreEnabled = false,
  profileId = null,
  send = null,
  db = getDb(),
} = {}) {
  const runDate = date || todayIso(now);
  const settings = reportSettings();

  if (!settings.enabled && !ignoreEnabled) {
    logger.debug('stock report skipped — disabled');
    return { runDate, status: 'skipped', reason: 'disabled', sent: 0, results: [] };
  }

  let profiles;
  if (profileId !== null && profileId !== undefined) {
    const one = getProfile(profileId, { db });
    if (!one) throw httpError(404, 'profile not found');
    profiles = [one];
  } else {
    profiles = sendableProfiles({ db });
  }

  if (!profiles.length) {
    logger.warn('stock report skipped — no enabled profile has recipients (Settings → Stock Report)');
    return { runDate, status: 'skipped', reason: 'no profiles with recipients', sent: 0, results: [] };
  }

  const syncNote = settings.syncFirst ? await refreshItems() : { attempted: false, ok: false, skipped: 'sync_first off' };

  const results = [];
  for (const profile of profiles) {
    // one bad profile must not abort the rest of the round
    try {
      results.push(await sendProfile({ profile, date: runDate, now, force, send, syncNote, db }));
    } catch (err) {
      logger.error({ err: err.message, profile: profile.name }, 'stock report profile threw');
      results.push({ runDate, profileId: profile.id, profileName: profile.name, status: 'failed', sent: false, error: err.message });
    }
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  return {
    runDate,
    status: sent ? 'sent' : results.every((r) => r.status === 'skipped_dedupe') ? 'skipped_dedupe' : results.length ? results[0].status : 'skipped',
    sent,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => String(r.status).startsWith('skipped')).length,
    syncNote,
    results,
  };
}

/** The cron/boot entry point — same flow, never throws at the caller. */
async function runStockReportJob({ now = new Date(), force = false } = {}) {
  const result = await sendReport({ now, force });
  return {
    runDate: result.runDate,
    status: result.status,
    reason: result.reason || null,
    profiles: result.results ? result.results.length : 0,
    sent: result.sent || 0,
    failed: result.failed || 0,
    skipped: result.skipped || 0,
  };
}

module.exports = {
  RULE_TYPE,
  ENTITY_TYPE,
  DEFAULT_TIME,
  DEFAULT_THRESHOLD,
  MAX_THRESHOLD,
  MASK_LABEL,
  parseJsonArray,
  clampThreshold,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  maxAttachmentBytes,
  reportTime,
  reportSettings,
  listProfiles,
  getProfile,
  sendableProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
  fmtDate,
  formatQty,
  maskQty,
  itemsSyncState,
  compose,
  guardKey,
  alreadySentToday,
  lastRun,
  minutesOf,
  shouldCatchUp,
  refreshItems,
  sendProfile,
  sendReport,
  runStockReportJob,
};
