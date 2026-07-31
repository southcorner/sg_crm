'use strict';

/**
 * SG CRM server entrypoint.
 *
 * One long-lived process: Express API + (in production) the built React client.
 * Later phases add node-cron jobs and the WhatsApp client to this same process.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);

const config = require('./config');
const logger = require('./logger');
const { getDb, closeDb } = require('./db/connection');
const { runMigrations } = require('./db/migrate');
const { ensureAdminUser } = require('./services/adminUser');
const { requireAuth } = require('./middleware/auth');
const apiRoutes = require('./routes');
const cronJobs = require('./jobs/cron');

function bootstrapDatabase() {
  const db = getDb();
  const applied = runMigrations();
  if (applied.length) logger.info({ applied }, 'migrations run');
  config.seedSettingDefaults();
  ensureAdminUser();
  return db;
}

function createApp(db) {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use(
    session({
      name: 'sg_crm.sid',
      secret: config.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: new SqliteStore({
        client: db,
        expired: { clear: true, intervalMs: 15 * 60 * 1000 },
      }),
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false, // LAN deployment over http
        maxAge: config.SESSION_MAX_AGE_MS,
      },
    })
  );

  // every /api route except the public ones needs a session
  app.use('/api', requireAuth, apiRoutes);

  // In production the same process serves the Vite build.
  if (config.isProduction) {
    const distDir = config.CLIENT_DIST_DIR;
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      // SPA fallback — anything that is not /api and not a real file
      app.get(/^\/(?!api\/).*/, (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    } else {
      logger.warn({ distDir }, 'client build not found — run `npm run build`');
    }
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'internal server error' });
  });

  return app;
}

function start() {
  const db = bootstrapDatabase();
  const app = createApp(db);

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, db: config.DB_PATH },
      'sg-crm server listening'
    );
    // schedulers live in this process; nothing else may start them
    const cronStatus = cronJobs.start();
    logger.info({ cron: cronStatus.started, sendTime: cronStatus.sendTime }, 'cron boot');
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    cronJobs.stop();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

module.exports = { createApp, bootstrapDatabase, start };

if (require.main === module) {
  start();
}
