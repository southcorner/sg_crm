'use strict';

const bcrypt = require('bcryptjs');
const { getDb } = require('../db/connection');
const config = require('../config');
const logger = require('../logger');

const SALT_ROUNDS = 10;

function getAdmin() {
  return getDb().prepare('SELECT * FROM admin_user ORDER BY id LIMIT 1').get();
}

function getAdminById(id) {
  return getDb().prepare('SELECT * FROM admin_user WHERE id = ?').get(id);
}

/**
 * First-boot bootstrap: if there is no admin row, create one from
 * ADMIN_USERNAME / ADMIN_PASSWORD (defaults: admin / admin123).
 */
function ensureAdminUser() {
  const existing = getAdmin();
  if (existing) return existing;

  const username = config.ADMIN_USERNAME;
  const password = config.ADMIN_PASSWORD;
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);

  getDb()
    .prepare('INSERT INTO admin_user (username, password_hash) VALUES (?, ?)')
    .run(username, hash);

  if (config.ADMIN_PASSWORD_IS_DEFAULT) {
    logger.warn(
      { username },
      'created admin user with the DEFAULT password "admin123" — set ADMIN_PASSWORD in .env or change it in Settings'
    );
  } else {
    logger.info({ username }, 'created admin user from ADMIN_PASSWORD');
  }

  return getAdmin();
}

/** Returns the admin row on success, null otherwise. */
function verifyCredentials(username, password) {
  const admin = getAdmin();
  if (!admin) return null;
  if (String(username || '').toLowerCase() !== admin.username.toLowerCase()) return null;
  if (!bcrypt.compareSync(String(password || ''), admin.password_hash)) return null;
  return admin;
}

function markLogin(id) {
  getDb().prepare("UPDATE admin_user SET last_login_at = datetime('now') WHERE id = ?").run(id);
}

function changePassword(id, newPassword) {
  const hash = bcrypt.hashSync(String(newPassword), SALT_ROUNDS);
  getDb()
    .prepare("UPDATE admin_user SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(hash, id);
}

/** Shape sent to the client — never includes the hash. */
function publicAdmin(admin) {
  if (!admin) return null;
  return {
    id: admin.id,
    username: admin.username,
    last_login_at: admin.last_login_at,
  };
}

module.exports = {
  ensureAdminUser,
  getAdmin,
  getAdminById,
  verifyCredentials,
  markLogin,
  changePassword,
  publicAdmin,
};
