'use strict';

/**
 * Numbered migration runner.
 *
 * Every *.sql file in ./migrations is applied once, in filename order
 * (001_init.sql, 002_..., ...), each inside a transaction, and recorded in
 * schema_migrations. Applied files are never re-run — add a new numbered file
 * to change the schema.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('./connection');
const logger = require('../logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** Apply any pending migrations. Returns the list of names applied. */
function runMigrations() {
  const db = getDb();
  ensureMigrationsTable(db);

  const applied = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((r) => r.name)
  );

  const pending = listMigrationFiles().filter((f) => !applied.has(f));
  if (pending.length === 0) {
    logger.debug({ applied: applied.size }, 'no pending migrations');
    return [];
  }

  const insert = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      insert.run(file);
    });
    try {
      apply();
      logger.info({ migration: file }, 'migration applied');
    } catch (err) {
      logger.error({ migration: file, err: err.message }, 'migration failed');
      throw err;
    }
  }

  return pending;
}

module.exports = { runMigrations, listMigrationFiles };

// `npm run migrate` — apply migrations and exit.
if (require.main === module) {
  const applied = runMigrations();
  logger.info({ count: applied.length, applied }, 'migrations up to date');
  require('./connection').closeDb();
}
