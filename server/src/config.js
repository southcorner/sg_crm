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

const env = {
  ROOT_DIR,
  DATA_DIR,
  DB_PATH,
  CLIENT_DIST_DIR: path.join(ROOT_DIR, 'client', 'dist'),
  WWEBJS_DIR: path.join(DATA_DIR, 'wwebjs'),

  NODE_ENV: process.env.NODE_ENV || 'development',
  get isProduction() {
    return this.NODE_ENV === 'production';
  },
  PORT: Number(process.env.PORT || 3000),

  SESSION_SECRET: process.env.SESSION_SECRET || 'sg-crm-dev-secret-change-me',
  SESSION_MAX_AGE_MS: 1000 * 60 * 60 * 24 * 30, // 30 days

  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
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

/** Defaults for the UI-editable settings, seeded on first boot. */
const SETTING_DEFAULTS = {
  digest_send_time: '09:00',
  dormant_months: 3,
  cheque_lead_days: 3,
  overdue_min_days: 1,
  overdue_min_amount: 0,
  overdue_resend_days: 7,
  zoho_daily_call_budget: 2000,
  sync_enabled: false,
  // SMTP — seeded empty so the settings UI has something to bind to. The
  // password is deliberately NOT seeded: it is write-only via /api/settings.
  smtp_host: '',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: '',
  smtp_from: '',
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
  SETTING_DEFAULTS,
  getSetting,
  setSetting,
  getAllSettings,
  seedSettingDefaults,
};
