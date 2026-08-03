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

/**
 * better-sqlite3-session-store sweeps expired sessions on a setInterval it
 * neither stores nor unrefs, which pins the event loop open forever — the
 * process would never exit on its own and `node --test` would hang. Same sweep,
 * unref'd, and the handle kept so shutdown can clear it.
 */
class SessionStore extends SqliteStore {
  startInterval() {
    this.expiryTimer = setInterval(() => this.clearExpiredSessions(), this.expired.intervalMs);
    this.expiryTimer.unref();
  }

  stopInterval() {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
  }
}

const config = require('./config');
const logger = require('./logger');
const { getDb, closeDb } = require('./db/connection');
const { runMigrations } = require('./db/migrate');
const adminUserService = require('./services/adminUser');
const { ensureAdminUser } = adminUserService;
const { requireAuth } = require('./middleware/auth');
const apiRoutes = require('./routes');
const cronJobs = require('./jobs/cron');
const whatsapp = require('./services/reminders/whatsapp');

/**
 * Refuse to start a production process that is misconfigured in a way that is
 * dangerous rather than merely inconvenient, and shout about the things that
 * are inconvenient. Called before anything opens a port or a database.
 */
function assertProductionConfig() {
  const problems = config.productionConfigProblems();
  if (problems.length) {
    const message =
      '\n=== SG CRM cannot start in production ===\n' +
      problems.map((p) => `  * ${p}`).join('\n') +
      `\n\nFix C:\\sg_crm\\.env and start again (see .env.example).\n`;
    process.stderr.write(message);
    logger.fatal({ problems }, 'production config invalid — refusing to start');
    process.exit(1);
  }
}

/** Non-fatal “you really should fix this” warnings, logged loudly once at boot. */
function warnAboutWeakConfig() {
  if (adminUserService.isUsingDefaultPassword()) {
    const banner =
      '\n!!!  The admin account is still using the DEFAULT password "admin123".  !!!\n' +
      '!!!  Log in and change it under Settings -> Security, now.               !!!\n';
    process.stderr.write(banner);
    logger.warn(
      { username: config.ADMIN_USERNAME },
      'SECURITY: the admin account still has the default password — change it in Settings → Security'
    );
  }
  if (config.isProduction && !fs.existsSync(config.CLIENT_DIST_DIR)) {
    logger.warn({ distDir: config.CLIENT_DIST_DIR }, 'client build missing — run `npm run build`');
  }
}

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

  const sessionStore = new SessionStore({
    client: db,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  });
  app.locals.sessionStore = sessionStore;

  app.use(
    session({
      name: 'sg_crm.sid',
      secret: config.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      // Cookie hardening, and the one deliberate gap:
      //   httpOnly  — script can never read the session id
      //   sameSite  — 'lax' blocks cross-site POSTs (the CSRF vector here)
      //   secure    — MUST stay false: this is a LAN deployment over plain
      //               http://<server>:3000 with no certificate. A `secure`
      //               cookie would simply never be sent and nobody could log
      //               in. Put the box behind a TLS reverse proxy and flip
      //               SESSION_COOKIE_SECURE=true if that ever changes.
      //   path      — the whole app; there is nothing else on this origin.
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: String(process.env.SESSION_COOKIE_SECURE || '').toLowerCase() === 'true',
        path: '/',
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
  assertProductionConfig();
  const db = bootstrapDatabase();
  warnAboutWeakConfig();
  const app = createApp(db);

  const server = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        env: config.NODE_ENV,
        db: config.DB_PATH,
        logFile: logger.logFile || null,
        node: process.version,
      },
      'sg-crm server listening'
    );
    // schedulers live in this process; nothing else may start them
    const cronStatus = cronJobs.start();
    logger.info(
      { cron: cronStatus.started, sendTime: cronStatus.sendTime, stockTime: cronStatus.stockTime },
      'cron boot'
    );

    // The admin switches this machine on in the morning. If that happens after
    // the stock report's slot, send it now rather than skipping the day.
    cronJobs
      .stockReportCatchUp({})
      .then((r) => logger.info({ ran: Boolean(r.ran), reason: r.reason }, 'stock report catch-up'))
      .catch((err) => logger.error({ err: err.message }, 'stock report catch-up failed'));

    // Lazy by design: no puppeteer, no Chromium, no session unless the admin
    // has switched the channel on in Settings → WhatsApp.
    whatsapp
      .initializeIfEnabled()
      .then((s) => logger.info({ enabled: s.enabled, state: s.state }, 'whatsapp boot'))
      .catch((err) => logger.error({ err: err.message }, 'whatsapp boot failed'));
  });

  // The single most common Windows failure: a stray `npm start` still holding
  // the port, or the service already running. Say so instead of dumping a stack.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `\nPort ${config.PORT} is already in use — another SG CRM (or the SgCrm service) is running.\n` +
          `  netstat -ano | findstr :${config.PORT}      # find the PID\n` +
          '  nssm status SgCrm                        # is the service up?\n' +
          'Stop it, or set PORT in .env to something else.\n'
      );
      logger.fatal({ port: config.PORT }, 'port already in use');
      process.exit(1);
    }
    logger.fatal({ err: err.message, code: err.code }, 'server error');
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    cronJobs.stop();
    if (app.locals.sessionStore) app.locals.sessionStore.stopInterval();
    // close the browser before the process goes, or Chromium is orphaned
    Promise.resolve(whatsapp.destroy())
      .catch((err) => logger.warn({ err: err.message }, 'whatsapp shutdown failed'))
      .then(() => {
        server.close(() => {
          closeDb();
          logger.flushLogFile();
          process.exit(0);
        });
      });
    setTimeout(() => {
      logger.flushLogFile();
      process.exit(1);
    }, 20000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // NSSM sends Ctrl-Break / a console close event before it kills the process
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  // A crash must leave a trace in app.log, then let NSSM restart us.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception — exiting');
    logger.flushLogFile();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });

  return server;
}

module.exports = { createApp, bootstrapDatabase, start, assertProductionConfig, warnAboutWeakConfig };

if (require.main === module) {
  start();
}
