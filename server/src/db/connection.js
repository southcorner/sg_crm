'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../logger');

let db = null;

/**
 * Open (once) the SQLite connection with the pragmas the plan requires:
 * WAL journalling, foreign keys ON, 5s busy timeout.
 */
function getDb() {
  if (db) return db;

  config.ensureDataDir();

  db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  logger.info({ db: path.relative(config.ROOT_DIR, config.DB_PATH) }, 'sqlite connection opened');
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
