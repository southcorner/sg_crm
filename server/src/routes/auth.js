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

// GET /api/auth/me — 200 with user:null when not logged in, so the client can
// bootstrap without tripping its own 401 redirect.
router.get('/me', (req, res) => {
  if (!req.session || !req.session.adminId) return res.json({ user: null });
  const admin = adminUser.getAdminById(req.session.adminId);
  if (!admin) return res.json({ user: null });
  return res.json({ user: adminUser.publicAdmin(admin) });
});

module.exports = router;
