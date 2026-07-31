'use strict';

/**
 * In-process schedulers (node-cron). Started from index.js on boot and from
 * nowhere else — the seeder, the migrations and the test suite must never bring
 * a scheduler up, so nothing here runs on `require`.
 *
 * Two jobs:
 *   digest  `digest_send_time` (default 09:00), Mon–Sat. Re-registered whenever
 *           the setting changes — the settings route calls rescheduleDigest().
 *   sync    Zoho incremental sync every 30 minutes between 08:00 and 20:00,
 *           Mon–Sat. Silently does nothing when Zoho is not connected.
 *
 * Every handler is wrapped: a throwing job logs and leaves the schedule intact
 * rather than taking the process down.
 */

const cron = require('node-cron');
const config = require('../config');
const logger = require('../logger');

const DEFAULT_SEND_TIME = '09:00';
// Mon–Sat. Sunday digests would just pile up unread on Monday.
const WORK_DAYS = '1-6';
// every 30 min 08:00–19:30 plus a final 20:00 pass
const SYNC_CRON = `0,30 8-19 * * ${WORK_DAYS}`;
const SYNC_CRON_CLOSE = `0 20 * * ${WORK_DAYS}`;

const tasks = new Map(); // name → node-cron task
let started = false;
let lastRuns = {}; // name → {at, ok, detail}

/** 'HH:MM' → a cron expression, falling back to 09:00 on anything odd. */
function digestCronExpr(sendTime) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(sendTime || '').trim());
  const hour = match ? Number(match[1]) : 9;
  const minute = match ? Number(match[2]) : 0;
  const h = Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : 9;
  const m = Number.isFinite(minute) && minute >= 0 && minute <= 59 ? minute : 0;
  return `${m} ${h} * * ${WORK_DAYS}`;
}

function currentSendTime() {
  const value = String(config.getSetting('digest_send_time', DEFAULT_SEND_TIME) || DEFAULT_SEND_TIME);
  return /^(\d{1,2}):(\d{2})$/.test(value.trim()) ? value.trim() : DEFAULT_SEND_TIME;
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
  register('sync', SYNC_CRON, runSyncJob);
  register('sync_close', SYNC_CRON_CLOSE, runSyncJob);
  return getStatus();
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
    jobs: [
      { name: 'digest', expr: digestCronExpr(currentSendTime()), running: tasks.has('digest') },
      { name: 'sync', expr: SYNC_CRON, running: tasks.has('sync') },
      { name: 'sync_close', expr: SYNC_CRON_CLOSE, running: tasks.has('sync_close') },
    ],
    lastRuns,
  };
}

module.exports = {
  DEFAULT_SEND_TIME,
  SYNC_CRON,
  SYNC_CRON_CLOSE,
  digestCronExpr,
  currentSendTime,
  runDigestJob,
  runSyncJob,
  rescheduleDigest,
  isEnabled,
  start,
  stop,
  getStatus,
};
