'use strict';

/**
 * Config loader.
 *
 * Two layers:
 *   1. .env / process.env  — secrets and machine-level config (read once at boot)
 *   2. the `settings` table — UI-editable runtime config (read on demand)
 *
 * The settings helpers lazily require the db connection so that this module can be
 * imported by the db layer itself without a circular import.
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// repo root = server/src/.. /..
const ROOT_DIR = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}

const DATA_DIR = resolveFromRoot(process.env.DATA_DIR || 'data');
const DB_PATH = resolveFromRoot(process.env.DB_PATH || path.join('data', 'crm.db'));

const DEV_SESSION_SECRET = 'sg-crm-dev-secret-change-me';
const DEFAULT_ADMIN_PASSWORD = 'admin123';

const env = {
  ROOT_DIR,
  DATA_DIR,
  DB_PATH,
  LOGS_DIR: path.join(DATA_DIR, 'logs'),
  BACKUP_DIR: resolveFromRoot(process.env.BACKUP_DIR || path.join('data', 'backups')),
  CLIENT_DIST_DIR: path.join(ROOT_DIR, 'client', 'dist'),
  WWEBJS_DIR: path.join(DATA_DIR, 'wwebjs'),

  NODE_ENV: process.env.NODE_ENV || 'development',
  get isProduction() {
    return this.NODE_ENV === 'production';
  },
  PORT: Number(process.env.PORT || 3000),

  SESSION_SECRET: process.env.SESSION_SECRET || DEV_SESSION_SECRET,
  // production refuses to boot without a real one — see assertProductionConfig()
  SESSION_SECRET_IS_DEFAULT: !process.env.SESSION_SECRET,
  SESSION_MAX_AGE_MS: 1000 * 60 * 60 * 24 * 30, // 30 days

  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_PASSWORD,
  ADMIN_PASSWORD_IS_DEFAULT: !process.env.ADMIN_PASSWORD,

  // Zoho (phase 1) — refresh token + org id live in the settings table
  ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID || '',
  ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET || '',

  // SMTP (phase 4)
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: Number(process.env.SMTP_PORT || 587),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || '',
};

function ensureDataDir() {
  if (!fs.existsSync(env.DATA_DIR)) {
    fs.mkdirSync(env.DATA_DIR, { recursive: true });
  }
  return env.DATA_DIR;
}

/**
 * Fail-fast checks for a production boot. Returns the list of problems rather
 * than exiting, so it can be unit-tested; index.js prints them and exits 1.
 *
 * Only SESSION_SECRET is fatal: booting production with the built-in dev secret
 * would let anyone who has read the source forge a session cookie. Everything
 * else that is merely unwise is warned about in index.js.
 */
function productionConfigProblems(e = env) {
  const problems = [];
  if (e.NODE_ENV !== 'production') return problems;
  if (e.SESSION_SECRET_IS_DEFAULT || !e.SESSION_SECRET) {
    problems.push(
      'SESSION_SECRET is not set. Put a long random string in C:\\sg_crm\\.env before starting in production, e.g.\n' +
        '    SESSION_SECRET=' +
        'paste-32-plus-random-chars-here\n' +
        '  (generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")'
    );
  } else if (e.SESSION_SECRET.length < 16) {
    problems.push('SESSION_SECRET is shorter than 16 characters — use at least 32 random characters.');
  }
  return problems;
}

/** Defaults for the UI-editable settings, seeded on first boot. */
const SETTING_DEFAULTS = {
  digest_send_time: '09:00',
  dormant_months: 3,
  cheque_lead_days: 3,
  overdue_min_days: 1,
  overdue_min_amount: 0,
  overdue_resend_days: 7,
  // Which digest rules the SCHEDULED run may send. Switching one off stops it
  // going out automatically; it stays available from the Reminders page, so
  // this is "pause the nagging", not "delete the rule".
  rule_overdue_enabled: true,
  rule_cheque_enabled: true,
  rule_dormant_enabled: true,
  rule_focus_enabled: true,
  zoho_daily_call_budget: 2000,
  // Global rep visibility scope (services/attribution.js). null = every rep is
  // visible; an array of zoho_salesperson_ids narrows the whole CRM to them.
  visible_rep_ids: null,
  // ...and whether rows with NO salesperson at all are shown. True by default:
  // on the live org that is ~7,400 of 21,570 invoices, so hiding them is a
  // deliberate choice, never a default.
  show_unattributed: true,
  // Only invoices dated within this many months get their line items pulled
  // (one API call each). 0 = no limit. Widening it re-queues older invoices.
  line_item_backfill_months: 6,
  sync_enabled: false,
  // WhatsApp (phase 5) — off until an admin pairs a phone in Settings. Boot
  // never launches puppeteer while this is false.
  whatsapp_enabled: false,
  whatsapp_test_number: '',
  // SMTP — seeded empty so the settings UI has something to bind to. The
  // password is deliberately NOT seeded: it is write-only via /api/settings.
  smtp_host: '',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: '',
  smtp_from: '',
  // Daily dealer stock report (services/stock-report.js). Off until an admin
  // adds a profile with recipients — it goes to customers, not staff, so it
  // never turns itself on. Recipients, exclusions and the masking threshold
  // live per profile in `stock_report_profiles` (migration 003); only the
  // master switch, the schedule and the pre-send refresh are global.
  stock_report_enabled: false,
  stock_report_time: '08:30',
  stock_report_sync_first: true,
  // Item photos are fetched one API call each, so only the categories where a
  // picture actually helps a dealer choose. A racket is identified by its model
  // name; a jersey or a shoe is not.
  stock_image_categories: ['Badminton Jersey', 'Cycling Jersey', 'Shoes', 'String', 'Grip', 'Bags'],
  // How many thumbnails one post-sync pass may fetch (0 disables the queue).
  stock_image_batch: 100,
};

function db() {
  // lazy — avoids a circular require between config and the db connection
  return require('./db/connection').getDb();
}

/** Read a setting (JSON-decoded). Falls back to SETTING_DEFAULTS, then `fallback`. */
function getSetting(key, fallback) {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) {
    return key in SETTING_DEFAULTS ? SETTING_DEFAULTS[key] : fallback;
  }
  try {
    return JSON.parse(row.value);
  } catch (_err) {
    return row.value;
  }
}

/** Write a setting (JSON-encoded). */
function setSetting(key, value) {
  db()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(value));
  return value;
}

/** All settings as a plain object, defaults merged in. */
function getAllSettings() {
  const rows = db().prepare('SELECT key, value FROM settings').all();
  const out = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch (_err) {
      out[row.key] = row.value;
    }
  }
  return out;
}

/** Insert any missing default settings rows. Called once after migrations. */
function seedSettingDefaults() {
  const stmt = db().prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO NOTHING`
  );
  const tx = db().transaction((entries) => {
    for (const [key, value] of entries) stmt.run(key, JSON.stringify(value));
  });
  tx(Object.entries(SETTING_DEFAULTS));
}

module.exports = {
  ...env,
  isProduction: env.isProduction,
  ensureDataDir,
  productionConfigProblems,
  SETTING_DEFAULTS,
  getSetting,
  setSetting,
  getAllSettings,
  seedSettingDefaults,
};
