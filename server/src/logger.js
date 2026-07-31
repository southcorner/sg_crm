'use strict';

/**
 * Process logger (pino).
 *
 * Development / test: JSON on stdout only.
 *
 * Production: stdout **and** an append-only JSON file at `data/logs/app.log`.
 * stdout matters because NSSM redirects it to `data/logs/service-out.log`;
 * app.log matters because it survives whatever the service wrapper does and is
 * the file the runbook tells you to tail.
 *
 * Rotation is done in-process, by size, with no extra dependency: every
 * LOG_ROTATE_CHECK_MS the file is stat'ed and, once it is over LOG_MAX_SIZE_MB,
 * it is rolled to `app.log.1` (shifting `.1`→`.2`, … and dropping anything past
 * LOG_KEEP) and the destination is reopened. Renaming the open file works on
 * Windows because libuv opens with FILE_SHARE_DELETE, and the destination is
 * flushed before the roll, so nothing is lost.
 *
 * NSSM's own rotation (see scripts/install-service.ps1) covers service-out.log
 * and service-err.log. app.log is rotated here. Two mechanisms, no overlap.
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const config = require('./config');

const DEFAULT_MAX_SIZE_MB = 10;
const DEFAULT_KEEP = 5;
const DEFAULT_CHECK_MS = 60 * 1000;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const LOG_DIR = path.join(config.DATA_DIR, 'logs');
const LOG_FILE = process.env.LOG_FILE
  ? path.isAbsolute(process.env.LOG_FILE)
    ? process.env.LOG_FILE
    : path.join(config.ROOT_DIR, process.env.LOG_FILE)
  : path.join(LOG_DIR, 'app.log');

const MAX_SIZE_BYTES = num(process.env.LOG_MAX_SIZE_MB, DEFAULT_MAX_SIZE_MB) * 1024 * 1024;
const KEEP = Math.max(1, Math.trunc(num(process.env.LOG_KEEP, DEFAULT_KEEP)));
const CHECK_MS = num(process.env.LOG_ROTATE_CHECK_MS, DEFAULT_CHECK_MS);

const level = process.env.LOG_LEVEL || (config.NODE_ENV === 'production' ? 'info' : 'debug');

/**
 * Does this process write a log file at all? Production yes; anything else only
 * when LOG_FILE is set explicitly (handy when debugging a dev run).
 * `LOG_TO_FILE=false` turns it off everywhere.
 */
function fileLoggingEnabled() {
  const explicit = String(process.env.LOG_TO_FILE ?? '').trim();
  if (explicit !== '') {
    return !['0', 'false', 'no', 'off'].includes(explicit.toLowerCase());
  }
  if (level === 'silent') return false;
  return config.NODE_ENV === 'production' || Boolean(process.env.LOG_FILE);
}

/**
 * Roll `file` → `file.1` → … → `file.<keep>`, dropping the oldest.
 * Returns true when a roll happened; safe to call when the file is missing.
 * Exported for the unit tests.
 */
function rotateFiles(file, keep = KEEP) {
  if (!fs.existsSync(file)) return false;
  const oldest = `${file}.${keep}`;
  if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
  for (let i = keep - 1; i >= 1; i -= 1) {
    const from = `${file}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
  return true;
}

/** Rotate only when the file is at or over `maxBytes`. Exported for the tests. */
function rotateIfNeeded(file, { maxBytes = MAX_SIZE_BYTES, keep = KEEP } = {}) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (_err) {
    return false; // not there yet — nothing to roll
  }
  if (size < maxBytes) return false;
  return rotateFiles(file, keep);
}

function buildLogger() {
  const options = {
    level,
    base: undefined, // no pid/hostname noise on a single-machine deployment
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (!fileLoggingEnabled()) {
    return { logger: pino(options), destination: null };
  }

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  // sync:true — the fd is opened synchronously, so a fatal log written
  // milliseconds before process.exit() actually lands on disk. (With the async
  // destination, an early exit throws "sonic boom is not ready yet" and the
  // reason for the exit is lost, which is exactly the log line you need.)
  // Volume here is a few hundred lines a day; the cost is irrelevant.
  const fileDest = pino.destination({ dest: LOG_FILE, append: true, sync: true, mkdir: true });
  const streams = [
    { level, stream: process.stdout },
    { level, stream: fileDest },
  ];

  const instance = pino(options, pino.multistream(streams, { dedupe: false }));

  const timer = setInterval(() => {
    try {
      if (rotateIfNeeded(LOG_FILE)) {
        fileDest.flushSync();
        fileDest.reopen(LOG_FILE);
        instance.info({ file: LOG_FILE, keep: KEEP }, 'log file rotated');
      }
    } catch (err) {
      // log housekeeping must never take the server down
      process.stderr.write(`log rotation failed: ${err.message}\n`);
    }
  }, CHECK_MS);
  timer.unref();

  const flush = () => {
    try {
      fileDest.flushSync();
    } catch (_err) {
      /* the process is going away anyway */
    }
  };
  process.on('exit', flush);

  return { logger: instance, destination: fileDest, flush };
}

const built = buildLogger();
const logger = built.logger;

// housekeeping handles hung off the logger — not part of the logging API
logger.logFile = built.destination ? LOG_FILE : null;
logger.flushLogFile = built.flush || (() => {});
logger.rotateFiles = rotateFiles;
logger.rotateIfNeeded = rotateIfNeeded;
logger.logConfig = {
  file: built.destination ? LOG_FILE : null,
  level,
  maxBytes: MAX_SIZE_BYTES,
  keep: KEEP,
  checkMs: CHECK_MS,
};

module.exports = logger;
