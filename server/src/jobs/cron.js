'use strict';

/**
 * In-process schedulers (node-cron). Started from index.js on boot and from
 * nowhere else — the seeder, the migrations and the test suite must never bring
 * a scheduler up, so nothing here runs on `require`.
 *
 * Three jobs:
 *   digest  `digest_send_time` (default 09:00), Mon–Sat. Re-registered whenever
 *           the setting changes — the settings route calls rescheduleDigest().
 *   sync    Zoho incremental sync every 30 minutes between 08:00 and 20:00,
 *           Mon–Sat. Silently does nothing when Zoho is not connected.
 *   stock   the dealer stock report at `stock_report_time`, EVERY day — dealers
 *           order on Sundays too. Also re-registered on a settings change.
 *
 * Every handler is wrapped: a throwing job logs and leaves the schedule intact
 * rather than taking the process down.
 */

const cron = require('node-cron');
const config = require('../config');
const logger = require('../logger');

const DEFAULT_SEND_TIME = '09:00';
const DEFAULT_STOCK_TIME = '08:30';
// Mon–Sat. Sunday digests would just pile up unread on Monday.
const WORK_DAYS = '1-6';
// every 30 min 08:00–19:30 plus a final 20:00 pass
const SYNC_CRON = `0,30 8-19 * * ${WORK_DAYS}`;
const SYNC_CRON_CLOSE = `0 20 * * ${WORK_DAYS}`;

const tasks = new Map(); // name → node-cron task
let started = false;
let lastRuns = {}; // name → {at, ok, detail}

/** 'HH:MM' → {h, m}, falling back to `fallback` on anything odd. */
function parseTime(value, fallback = { h: 9, m: 0 }) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || h < 0 || h > 23 || !Number.isFinite(m) || m < 0 || m > 59) return fallback;
  return { h, m };
}

/** 'HH:MM' → a Mon–Sat cron expression, falling back to 09:00 on anything odd. */
function digestCronExpr(sendTime) {
  const { h, m } = parseTime(sendTime, { h: 9, m: 0 });
  return `${m} ${h} * * ${WORK_DAYS}`;
}

/** 'HH:MM' → an EVERY-day cron expression, falling back to 08:30. */
function stockCronExpr(sendTime) {
  const { h, m } = parseTime(sendTime, { h: 8, m: 30 });
  return `${m} ${h} * * *`;
}

function currentSendTime() {
  const value = String(config.getSetting('digest_send_time', DEFAULT_SEND_TIME) || DEFAULT_SEND_TIME);
  return /^(\d{1,2}):(\d{2})$/.test(value.trim()) ? value.trim() : DEFAULT_SEND_TIME;
}

function currentStockTime() {
  const value = String(config.getSetting('stock_report_time', DEFAULT_STOCK_TIME) || DEFAULT_STOCK_TIME);
  return /^(\d{1,2}):(\d{2})$/.test(value.trim()) ? value.trim() : DEFAULT_STOCK_TIME;
}

function record(name, ok, detail) {
  lastRuns = { ...lastRuns, [name]: { at: new Date().toISOString(), ok, detail: detail || null } };
}

/** Register (or replace) a task under `name`. */
function register(name, expr, handler) {
  const existing = tasks.get(name);
  if (existing) {
    existing.stop();
    tasks.delete(name);
  }
  if (!cron.validate(expr)) {
    logger.error({ name, expr }, 'refusing to register an invalid cron expression');
    return null;
  }
  const task = cron.schedule(expr, () => {
    Promise.resolve()
      .then(handler)
      .then((result) => record(name, true, result || null))
      .catch((err) => {
        record(name, false, { error: err.message });
        logger.error({ err: err.message, stack: err.stack, job: name }, 'scheduled job failed');
      });
  });
  tasks.set(name, task);
  logger.info({ job: name, expr }, 'cron job registered');
  return task;
}

// ---------------------------------------------------------------------------
// job bodies
// ---------------------------------------------------------------------------

async function runDigestJob() {
  const engine = require('../services/reminders/engine');
  const result = await engine.run({});
  const summary = {
    runDate: result.runDate,
    digests: result.digests.length,
    sent: result.results.filter((r) => r.status === 'sent').length,
    failed: result.results.filter((r) => r.status === 'failed').length,
    skipped: result.results.filter((r) => String(r.status).startsWith('skipped')).length,
  };
  logger.info(summary, 'digest job finished');
  return summary;
}

async function runSyncJob() {
  const sync = require('../zoho/sync');
  const auth = require('../zoho/auth');
  if (!auth.isConnected()) {
    logger.debug('scheduled sync skipped — Zoho is not connected');
    return { skipped: true, reason: 'not connected' };
  }
  if (sync.isRunning()) {
    logger.debug('scheduled sync skipped — a sync is already running');
    return { skipped: true, reason: 'already running' };
  }
  const result = await sync.runSync({});
  logger.info({ ok: result.ok, halted: Boolean(result.halted) }, 'scheduled sync finished');
  return { ok: result.ok, halted: Boolean(result.halted), errors: (result.errors || []).length };
}

/**
 * The dealer stock report. Its own module owns the enabled / recipients /
 * once-per-day checks, so the job body stays this thin and the cron entry and
 * the boot catch-up cannot drift apart.
 */
async function runStockReportJob() {
  const stockReport = require('../services/stock-report');
  const summary = await stockReport.runStockReportJob({});
  logger.info(summary, 'stock report job finished');
  return summary;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/** Point the digest job at the currently configured send time. */
function rescheduleDigest() {
  if (!started) return null;
  const sendTime = currentSendTime();
  const expr = digestCronExpr(sendTime);
  register('digest', expr, runDigestJob);
  return { job: 'digest', sendTime, expr };
}

/** Same, for the stock report. Registered even when the feature is off — the
 *  job itself no-ops, which keeps "enable it and wait" working without a
 *  restart. */
function rescheduleStockReport() {
  if (!started) return null;
  const sendTime = currentStockTime();
  const expr = stockCronExpr(sendTime);
  register('stock_report', expr, runStockReportJob);
  return { job: 'stock_report', sendTime, expr };
}

function isEnabled() {
  const raw = String(process.env.ENABLE_CRON ?? 'true').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function start() {
  if (started) return getStatus();
  if (!isEnabled()) {
    logger.info('cron disabled (ENABLE_CRON)');
    return { enabled: false, started: false, jobs: [] };
  }
  started = true;
  rescheduleDigest();
  rescheduleStockReport();
  register('sync', SYNC_CRON, runSyncJob);
  register('sync_close', SYNC_CRON_CLOSE, runSyncJob);
  return getStatus();
}

/**
 * Fire today's stock report if the machine came up after its send time and the
 * day has not gone out yet. The admin's routine is "switch the PC on in the
 * morning", so a boot at 09:10 must not silently lose the 08:30 slot.
 *
 * Gated on the same ENABLE_CRON switch as everything else: a process started
 * with schedulers off must not mail dealers either.
 */
async function stockReportCatchUp({ now = new Date() } = {}) {
  if (!isEnabled()) return { catchUp: false, reason: 'cron disabled' };
  const stockReport = require('../services/stock-report');
  const decision = stockReport.shouldCatchUp({ now });
  if (!decision.catchUp) {
    logger.debug(decision, 'stock report catch-up not needed');
    return decision;
  }
  logger.info(decision, 'stock report catch-up: running the missed send');
  const summary = await stockReport.runStockReportJob({ now });
  record('stock_report_catchup', true, summary);
  return { ...decision, ran: true, ...summary };
}

function stop() {
  for (const [name, task] of tasks) {
    task.stop();
    logger.debug({ job: name }, 'cron job stopped');
  }
  tasks.clear();
  started = false;
  return { started: false };
}

function getStatus() {
  return {
    enabled: isEnabled(),
    started,
    sendTime: currentSendTime(),
    stockTime: currentStockTime(),
    jobs: [
      { name: 'digest', expr: digestCronExpr(currentSendTime()), running: tasks.has('digest') },
      { name: 'stock_report', expr: stockCronExpr(currentStockTime()), running: tasks.has('stock_report') },
      { name: 'sync', expr: SYNC_CRON, running: tasks.has('sync') },
      { name: 'sync_close', expr: SYNC_CRON_CLOSE, running: tasks.has('sync_close') },
    ],
    lastRuns,
  };
}

module.exports = {
  DEFAULT_SEND_TIME,
  DEFAULT_STOCK_TIME,
  SYNC_CRON,
  SYNC_CRON_CLOSE,
  parseTime,
  digestCronExpr,
  stockCronExpr,
  currentSendTime,
  currentStockTime,
  runDigestJob,
  runSyncJob,
  runStockReportJob,
  rescheduleDigest,
  rescheduleStockReport,
  stockReportCatchUp,
  isEnabled,
  start,
  stop,
  getStatus,
};
