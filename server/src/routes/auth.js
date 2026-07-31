'use strict';

const express = require('express');
const { z } = require('zod');
const adminUser = require('../services/adminUser');
const logger = require('../logger');

const router = express.Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const { username, password } = parsed.data;
  const admin = adminUser.verifyCredentials(username, password);
  if (!admin) {
    logger.warn({ username }, 'failed login attempt');
    return res.status(401).json({ error: 'invalid username or password' });
  }

  // guard against session fixation
  req.session.regenerate((err) => {
    if (err) {
      logger.error({ err: err.message }, 'session regenerate failed');
      return res.status(500).json({ error: 'could not start session' });
    }
    req.session.adminId = admin.id;
    req.session.username = admin.username;
    adminUser.markLogin(admin.id);
    req.session.save((saveErr) => {
      if (saveErr) {
        logger.error({ err: saveErr.message }, 'session save failed');
        return res.status(500).json({ error: 'could not start session' });
      }
      logger.info({ username: admin.username }, 'admin logged in');
      return res.json({ user: adminUser.publicAdmin(adminUser.getAdminById(admin.id)) });
    });
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy((err) => {
    if (err) logger.error({ err: err.message }, 'session destroy failed');
    res.clearCookie('sg_crm.sid');
    return res.json({ ok: true });
  });
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'current password is required'),
  new_password: z
    .string()
    .min(8, 'the new password must be at least 8 characters')
    .max(200, 'the new password is too long'),
});

/**
 * POST /api/auth/change-password  {current_password, new_password}
 *
 * Session-protected (it is not in middleware/auth.js PUBLIC_PATHS). The current
 * password is re-checked here even though the caller is already logged in — a
 * borrowed browser tab must not be enough to lock the owner out. The session is
 * regenerated afterwards so the cookie that existed before the change cannot be
 * replayed.
 */
router.post('/change-password', (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const admin = adminUser.getAdminById(req.session.adminId);
  if (!admin) return res.status(401).json({ error: 'unauthorized' });

  const { current_password: currentPassword, new_password: newPassword } = parsed.data;
  if (!adminUser.verifyCredentials(admin.username, currentPassword)) {
    logger.warn({ username: admin.username }, 'change-password rejected: wrong current password');
    return res.status(400).json({ error: 'the current password is not correct' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'the new password must be different from the current one' });
  }

  adminUser.changePassword(admin.id, newPassword);
  logger.info({ username: admin.username }, 'admin password changed');

  // keep the admin logged in, but on a brand-new session id
  req.session.regenerate((err) => {
    if (err) {
      logger.error({ err: err.message }, 'session regenerate after password change failed');
      return res.json({ ok: true, reauth: true });
    }
    req.session.adminId = admin.id;
    req.session.username = admin.username;
    req.session.save(() => res.json({ ok: true, user: adminUser.publicAdmin(adminUser.getAdminById(admin.id)) }));
  });
});

// GET /api/auth/me — 200 with user:null when not logged in, so the client can
// bootstrap without tripping its own 401 redirect.
router.get('/me', (req, res) => {
  if (!req.session || !req.session.adminId) return res.json({ user: null });
  const admin = adminUser.getAdminById(req.session.adminId);
  if (!admin) return res.json({ user: null });
  return res.json({ user: adminUser.publicAdmin(admin) });
});

module.exports = router;
