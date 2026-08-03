'use strict';

/**
 * Email delivery for the digests.
 *
 * SMTP config comes from the `settings` table first (admin-editable in Settings →
 * Reminders) and falls back to .env, so a machine can be provisioned before
 * anyone logs in. The password is the one setting the API never reads back —
 * /api/settings masks it to `smtp_pass_set: true|false`.
 *
 * The transport is built lazily and cached; `resetTransport()` is called by the
 * settings route whenever an smtp_* key changes, so an admin never has to
 * restart the server to fix a typo'd host.
 *
 * SMTP_TRANSPORT=json|stream short-circuits to nodemailer's built-in fake
 * transports. That is how the phase-4 verification exercises a real end-to-end
 * run without pointing at anybody's mail server; it is never used in production.
 */

const nodemailer = require('nodemailer');
const config = require('../../config');
const logger = require('../../logger');

let cached = null;
let cachedKey = null;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Effective SMTP config: settings row → .env → default. */
function smtpConfig() {
  const s = config.getAllSettings();
  const host = String(s.smtp_host || config.SMTP_HOST || '').trim();
  const port = Number(s.smtp_port || config.SMTP_PORT || 587);
  const user = String(s.smtp_user || config.SMTP_USER || '').trim();
  const pass = String(s.smtp_pass || config.SMTP_PASS || '');
  const from = String(s.smtp_from || config.SMTP_FROM || user || '').trim();
  // port 465 is implicit TLS; anything else defaults to STARTTLS
  const secure = s.smtp_secure === undefined || s.smtp_secure === null || s.smtp_secure === ''
    ? port === 465
    : bool(s.smtp_secure, port === 465);

  return { host, port, secure, user, pass, from };
}

/** What the UI needs to know without ever seeing the password. */
function status() {
  const cfg = smtpConfig();
  const override = String(process.env.SMTP_TRANSPORT || '').toLowerCase();
  return {
    configured: Boolean(override) || Boolean(cfg.host && cfg.from),
    host: cfg.host || null,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user || null,
    from: cfg.from || null,
    passSet: Boolean(cfg.pass),
    testTransport: override || null,
  };
}

function isConfigured() {
  return status().configured;
}

/** Drop the cached transport — call after any smtp_* setting changes. */
function resetTransport() {
  if (cached && typeof cached.close === 'function') {
    try {
      cached.close();
    } catch (_err) {
      /* nothing useful to do if the pool is already gone */
    }
  }
  cached = null;
  cachedKey = null;
}

function getTransport() {
  const override = String(process.env.SMTP_TRANSPORT || '').toLowerCase();
  if (override === 'json') return nodemailer.createTransport({ jsonTransport: true });
  if (override === 'stream') return nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });

  const cfg = smtpConfig();
  if (!cfg.host) throw httpError(400, 'SMTP is not configured — set the mail server in Settings → Reminders');

  const key = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass ? 'set' : '']);
  if (cached && cachedKey === key) return cached;

  resetTransport();
  cached = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  cachedKey = key;
  return cached;
}

function fromAddress() {
  const cfg = smtpConfig();
  return cfg.from || cfg.user || 'sg-crm@localhost';
}

/**
 * Send one mail. Throws on a bad address or a transport failure — the engine
 * turns that into a `failed` log row and carries on with the next rep.
 */
async function sendEmail(to, subject, html, text) {
  const recipient = String(to || '').trim();
  if (!recipient) throw httpError(400, 'no recipient address');

  const transport = getTransport();
  const info = await transport.sendMail({
    from: fromAddress(),
    to: recipient,
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
  });

  logger.debug({ to: recipient, subject, messageId: info.messageId }, 'digest email sent');
  return info;
}

/** Open a connection and hand it straight back — the Settings "test" button. */
async function verifyConnection() {
  const transport = getTransport();
  if (typeof transport.verify !== 'function') return { ok: true, verified: false, note: 'test transport' };
  await transport.verify();
  return { ok: true, verified: true };
}

/** Send a one-off "it works" mail to prove the config end to end. */
async function sendTestEmail(to) {
  const when = new Date().toLocaleString('en-IN');
  const info = await sendEmail(
    to,
    'SG CRM — SMTP test',
    `<div style="font-family:Segoe UI,Arial,sans-serif;padding:20px">
       <h2 style="margin:0 0 8px;color:#12263f">SMTP is working</h2>
       <p style="color:#52606d">Sent from SG CRM at ${when}. Daily digests will be delivered from this address.</p>
     </div>`,
    `SMTP is working. Sent from SG CRM at ${when}.`
  );
  return { ok: true, to, messageId: info.messageId || null, accepted: info.accepted || [], response: info.response || null };
}

/**
 * One mail to a list of recipients who must not see each other — the dealer
 * stock report. Everyone goes in Bcc and the From address is its own To, which
 * is what every mailer does for a bulk send and keeps the message RFC-valid
 * (a message with no To at all trips some spam filters).
 */
async function sendBcc(recipients, subject, html, text, attachments = []) {
  const list = (Array.isArray(recipients) ? recipients : [recipients])
    .map((r) => String(r || '').trim())
    .filter(Boolean);
  if (!list.length) throw httpError(400, 'no recipient addresses');

  const files = (Array.isArray(attachments) ? attachments : [attachments]).filter(Boolean);

  const transport = getTransport();
  const from = fromAddress();
  const info = await transport.sendMail({
    from,
    to: from,
    bcc: list,
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
    ...(files.length ? { attachments: files } : {}),
  });

  logger.debug(
    { bcc: list.length, subject, attachments: files.length, messageId: info.messageId },
    'bulk email sent'
  );
  return info;
}

module.exports = {
  smtpConfig,
  status,
  isConfigured,
  getTransport,
  resetTransport,
  fromAddress,
  sendEmail,
  sendBcc,
  verifyConnection,
  sendTestEmail,
};
