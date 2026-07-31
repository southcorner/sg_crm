#!/usr/bin/env node
'use strict';

/**
 * Hot backup of the SQLite database, plus retention.
 *
 *   node server/scripts/backup-db.js [--out <dir>] [--keep 14] [--db <path>] [--json]
 *
 * Uses SQLite's own `VACUUM INTO`, which produces a fully consistent, already
 * compacted copy while the server keeps writing — no file copy, no WAL/-shm
 * juggling, and (the point of doing it here rather than in PowerShell) no
 * sqlite3.exe dependency: it runs through the better-sqlite3 the server already
 * has installed.
 *
 * The source database is opened **readonly**. The only thing this process
 * writes is the new file under the backup directory.
 *
 * Called by scripts/backup-db.ps1, which is what the scheduled task runs.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_KEEP = 14;
const PREFIX = 'crm-';
const SUFFIX = '.db';
const NAME_RE = /^crm-\d{8}-\d{6}\.db$/;

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--keep') args.keep = Number(argv[++i]);
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}

/** `crm-20260801-013000.db` — sorts correctly as a plain string. */
function timestampName(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${PREFIX}${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${SUFFIX}`
  );
}

/**
 * Delete all but the newest `keep` backups in `dir`.
 * Only files matching NAME_RE are ever considered, so nothing else in the
 * directory can be destroyed by a bad argument. Returns the deleted names.
 */
function pruneBackups(dir, keep = DEFAULT_KEEP) {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .sort() // timestamped names sort chronologically
    .reverse(); // newest first
  const doomed = files.slice(Math.max(1, keep));
  for (const f of doomed) fs.rmSync(path.join(dir, f), { force: true });
  return doomed;
}

/** Run the backup. Returns a summary object; throws on failure. */
function runBackup({ dbPath, outDir, keep = DEFAULT_KEEP, now = new Date() } = {}) {
  const source = resolveFromRoot(dbPath || process.env.DB_PATH || path.join('data', 'crm.db'));
  const dir = resolveFromRoot(outDir || process.env.BACKUP_DIR || path.join('data', 'backups'));

  if (!fs.existsSync(source)) {
    const err = new Error(`database not found: ${source}`);
    err.code = 'ENOENT';
    throw err;
  }
  fs.mkdirSync(dir, { recursive: true });

  const target = path.join(dir, timestampName(now));
  if (fs.existsSync(target)) fs.rmSync(target, { force: true }); // VACUUM INTO refuses to overwrite

  const started = Date.now();
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 15000');
    // better-sqlite3 will not bind a parameter here, so quote it ourselves
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  const elapsedMs = Date.now() - started;

  // prove the copy is readable and self-consistent before we prune anything
  const verify = new Database(target, { readonly: true, fileMustExist: true });
  let tables = 0;
  let integrity = 'unknown';
  try {
    integrity = verify.pragma('integrity_check', { simple: true });
    tables = verify
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get().n;
  } finally {
    verify.close();
  }
  if (integrity !== 'ok') {
    fs.rmSync(target, { force: true });
    throw new Error(`integrity_check on the backup returned "${integrity}" — backup discarded`);
  }

  const pruned = pruneBackups(dir, keep);
  const remaining = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).length;

  return {
    ok: true,
    source,
    file: target,
    bytes: fs.statSync(target).size,
    sourceBytes: fs.statSync(source).size,
    tables,
    integrity,
    elapsedMs,
    pruned,
    keep,
    remaining,
  };
}

module.exports = { runBackup, pruneBackups, timestampName, NAME_RE, DEFAULT_KEEP };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node server/scripts/backup-db.js [--db <path>] [--out <dir>] [--keep 14] [--json]\n'
    );
    process.exit(0);
  }
  try {
    const result = runBackup({
      dbPath: args.db,
      outDir: args.out,
      keep: Number.isFinite(args.keep) && args.keep > 0 ? Math.trunc(args.keep) : DEFAULT_KEEP,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
      process.stdout.write(
        `backup ok: ${result.file}\n` +
          `  ${mb(result.sourceBytes)} -> ${mb(result.bytes)} in ${result.elapsedMs} ms · ` +
          `${result.tables} tables · integrity ${result.integrity}\n` +
          `  kept ${result.remaining} (max ${result.keep})` +
          (result.pruned.length ? `, pruned ${result.pruned.length}: ${result.pruned.join(', ')}` : '') +
          '\n'
      );
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`backup failed: ${err.message}\n`);
    process.exit(1);
  }
}
