'use strict';

/**
 * WhatsApp delivery via whatsapp-web.js — an UNOFFICIAL library that drives a
 * real WhatsApp Web session in headless Chromium. Everything here is written
 * around three facts about that:
 *
 *   1. The session is a phone pairing, not an API key. It starts as a QR code,
 *      it can be unlinked from the phone at any moment, and it breaks whenever
 *      WhatsApp Web ships something the library has not caught up with. So the
 *      client is a *state machine* the UI can watch, never a function you call
 *      and assume works.
 *   2. Volume is the ban risk. Sends are therefore serialised through one queue
 *      with a random 4–8 s gap, never fanned out in parallel.
 *   3. Nothing here may ever block a digest. A send that hangs is killed by a
 *      30 s timeout, a session that is down fails fast, and the engine falls
 *      back to email — which is why WhatsApp is a *second* channel, not the
 *      primary one.
 *
 * Lifecycle: lazy. Boot does not touch puppeteer unless the `whatsapp_enabled`
 * setting is true, so a machine that has never paired a phone never launches a
 * browser.
 *
 * `createService(overrides)` builds an isolated instance with every side effect
 * injectable (client factory, QR renderer, clock, sleep, scheduler) — that is
 * how the tests exercise the state machine, the queue and the backoff without
 * downloading Chromium. The module's default export is one shared instance;
 * `configure()` swaps its collaborators for the enable/disable tests.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../../logger');

// --- constants --------------------------------------------------------------

const STATE = {
  DISCONNECTED: 'disconnected',
  INITIALIZING: 'initializing',
  QR_PENDING: 'qr_pending',
  AUTHENTICATED: 'authenticated',
  READY: 'ready',
};

/** Reasons the engine records against a failed whatsapp row. */
const REASON = {
  DISABLED: 'disabled',
  SESSION_DOWN: 'session_down',
  NO_NUMBER: 'no_number',
  OPTED_OUT: 'opted_out',
};

const DEFAULTS = {
  sendTimeoutMs: 30_000,
  sendDelayMinMs: 4_000,
  sendDelayMaxMs: 8_000,
  backoffMinMs: 30_000, // first reconnect attempt
  backoffMaxMs: 600_000, // ...doubling up to 10 minutes
};

const SETTING_ENABLED = 'whatsapp_enabled';
const SETTING_TEST_NUMBER = 'whatsapp_test_number';

// --- number normalisation ---------------------------------------------------

/**
 * '+91 98765 43210' | '09876543210' | '9876543210' | '919876543210@c.us'
 *   → '919876543210@c.us'
 *
 * India is assumed for bare 10-digit numbers (that is what the reps table
 * holds); anything already carrying a country code is passed through. Fewer
 * than 10 digits is a typo, not a number, and throws.
 */
function normalizeNumber(raw) {
  const input = String(raw ?? '').trim();
  if (!input) throw new Error('no whatsapp number');

  // tolerate an already-formatted chat id (91...@c.us / @s.whatsapp.net)
  const withoutSuffix = input.replace(/@[a-z.]+$/i, '');
  let digits = withoutSuffix.replace(/\D/g, '');

  // 00 91 ... / 0 98765 43210 — trunk and international prefixes
  digits = digits.replace(/^0+/, '');

  if (digits.length < 10) throw new Error(`"${input}" is not a usable whatsapp number`);
  if (digits.length === 10) digits = `91${digits}`;

  return `${digits}@c.us`;
}

// --- helpers ----------------------------------------------------------------

function randomBetween(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

function isoNow() {
  return new Date().toISOString();
}

/** Reject if `promise` has not settled within `ms` — a hung page must not wedge the queue. */
function withTimeout(promise, ms, message) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** The real client — required lazily so the test suite never loads puppeteer. */
function defaultClientFactory({ dataPath }) {
  // eslint-disable-next-line global-require
  const { Client, LocalAuth } = require('whatsapp-web.js');
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'sg-crm', dataPath }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    },
  });
}

/** The real QR renderer — also lazy, also swapped out in tests. */
function defaultQrToDataUrl(text) {
  // eslint-disable-next-line global-require
  const qrcode = require('qrcode');
  return qrcode.toDataURL(text, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
}

// ---------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------

function createService(overrides = {}) {
  const opts = {
    dataPath: config.WWEBJS_DIR,
    clientFactory: defaultClientFactory,
    qrToDataUrl: defaultQrToDataUrl,
    log: logger,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    scheduler: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) },
    sendDelayMs: null, // () => ms; default is the random 4–8 s window
    ...DEFAULTS,
    ...overrides,
  };
  const nextDelay = opts.sendDelayMs || (() => randomBetween(opts.sendDelayMinMs, opts.sendDelayMaxMs));

  const state = {
    status: STATE.DISCONNECTED,
    qrDataUrl: null,
    qrAt: null,
    lastReadyAt: null,
    lastError: null,
    lastErrorAt: null,
    startedAt: null,
    attempts: 0, // consecutive failed/lost sessions — drives the backoff
    nextRetryAt: null,
    me: null, // {pushname, number} once ready
  };

  let client = null;
  let generation = 0; // bumped on every (re)init so a dead client's events are ignored
  let retryTimer = null;
  let initPromise = Promise.resolve();

  const queue = [];
  let draining = false;
  let lastSendAt = null; // null = nothing sent yet, so the first message goes straight out
  const numberIds = new Map(); // '91...@c.us' → serialized id | null (not on WhatsApp)

  // --- state helpers --------------------------------------------------------

  function setStatus(next, extra = {}) {
    const previous = state.status;
    state.status = next;
    Object.assign(state, extra);
    if (previous !== next) opts.log.info({ from: previous, to: next }, 'whatsapp state');
    return state.status;
  }

  function recordError(message) {
    state.lastError = message || null;
    state.lastErrorAt = message ? isoNow() : null;
  }

  function isReady() {
    return state.status === STATE.READY;
  }

  function getStatus({ includeQr = true } = {}) {
    return {
      enabled: isEnabled(),
      state: state.status,
      ready: isReady(),
      qrDataUrl: includeQr && state.status === STATE.QR_PENDING ? state.qrDataUrl : null,
      hasQr: Boolean(state.qrDataUrl),
      qrAt: state.qrAt,
      lastReadyAt: state.lastReadyAt,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
      startedAt: state.startedAt,
      attempts: state.attempts,
      nextRetryAt: state.nextRetryAt,
      queue: queue.length,
      sending: draining,
      me: state.me,
      dataPath: opts.dataPath,
    };
  }

  // --- reconnect backoff ----------------------------------------------------

  function clearRetry() {
    if (retryTimer) {
      opts.scheduler.clearTimeout(retryTimer);
      retryTimer = null;
    }
    state.nextRetryAt = null;
  }

  /** 30 s → 1 m → 2 m → … → 10 m, reset the moment a session goes ready. */
  function backoffMs() {
    const step = Math.max(0, state.attempts - 1);
    return Math.min(opts.backoffMinMs * 2 ** step, opts.backoffMaxMs);
  }

  function scheduleReconnect(reason) {
    if (!isEnabled()) {
      opts.log.info({ reason }, 'whatsapp not re-initialising — the channel is disabled');
      return null;
    }
    clearRetry();
    state.attempts += 1;
    const delay = backoffMs();
    state.nextRetryAt = new Date(opts.now() + delay).toISOString();
    opts.log.warn({ reason, delayMs: delay, attempt: state.attempts }, 'whatsapp session lost — reconnect scheduled');
    retryTimer = opts.scheduler.setTimeout(() => {
      retryTimer = null;
      state.nextRetryAt = null;
      // destroy() has already run by the time we get here; start a clean client
      initialize({ reason: 'reconnect' }).catch((err) => opts.log.error({ err: err.message }, 'whatsapp reconnect failed'));
    }, delay);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
    return { delay, attempt: state.attempts, at: state.nextRetryAt };
  }

  /** A session died: tear the client down, then queue a fresh one. */
  async function handleSessionLoss(reason) {
    recordError(reason);
    await destroy({ keepEnabled: true, status: STATE.DISCONNECTED, quiet: true });
    scheduleReconnect(reason);
  }

  // --- lifecycle ------------------------------------------------------------

  function wireEvents(instance, myGeneration) {
    const live = () => myGeneration === generation;

    instance.on('qr', (qr) => {
      if (!live()) return;
      Promise.resolve(opts.qrToDataUrl(qr))
        .then((dataUrl) => {
          if (!live()) return;
          setStatus(STATE.QR_PENDING, { qrDataUrl: dataUrl, qrAt: isoNow() });
        })
        .catch((err) => {
          if (!live()) return;
          recordError(`could not render the QR code: ${err.message}`);
          opts.log.error({ err: err.message }, 'whatsapp qr render failed');
        });
    });

    instance.on('authenticated', () => {
      if (!live()) return;
      setStatus(STATE.AUTHENTICATED, { qrDataUrl: null, qrAt: null });
      recordError(null);
    });

    instance.on('ready', () => {
      if (!live()) return;
      clearRetry();
      state.attempts = 0;
      recordError(null);
      const info = instance.info || {};
      setStatus(STATE.READY, {
        qrDataUrl: null,
        qrAt: null,
        lastReadyAt: isoNow(),
        me: { pushname: info.pushname || null, number: (info.wid && (info.wid.user || info.wid._serialized)) || null },
      });
      drain();
    });

    instance.on('auth_failure', (message) => {
      if (!live()) return;
      handleSessionLoss(`auth_failure: ${message || 'unknown'}`).catch((err) =>
        opts.log.error({ err: err.message }, 'whatsapp auth_failure handling failed')
      );
    });

    instance.on('disconnected', (reason) => {
      if (!live()) return;
      handleSessionLoss(`disconnected: ${reason || 'unknown'}`).catch((err) =>
        opts.log.error({ err: err.message }, 'whatsapp disconnect handling failed')
      );
    });

    // never let an EventEmitter 'error' take the process down
    instance.on('error', (err) => {
      if (!live()) return;
      recordError(err && err.message ? err.message : String(err));
      opts.log.error({ err: state.lastError }, 'whatsapp client error');
    });
  }

  /**
   * Bring a client up. Returns as soon as the browser launch has been kicked
   * off — the caller polls getStatus() for qr_pending/ready rather than waiting,
   * because pairing needs a human with a phone.
   */
  async function initialize({ reason = 'manual' } = {}) {
    if (client) return getStatus();
    clearRetry();
    ensureDataDir();
    generation += 1;
    const myGeneration = generation;

    setStatus(STATE.INITIALIZING, { startedAt: isoNow(), qrDataUrl: null, qrAt: null });
    opts.log.info({ reason, dataPath: opts.dataPath }, 'whatsapp initialising');

    try {
      client = opts.clientFactory({ dataPath: opts.dataPath });
    } catch (err) {
      client = null;
      recordError(`client could not be created: ${err.message}`);
      setStatus(STATE.DISCONNECTED);
      scheduleReconnect(state.lastError);
      return getStatus();
    }

    wireEvents(client, myGeneration);

    initPromise = Promise.resolve()
      .then(() => client.initialize())
      .catch((err) => {
        if (myGeneration !== generation) return;
        opts.log.error({ err: err.message }, 'whatsapp initialize failed');
        handleSessionLoss(`initialize failed: ${err.message}`).catch(() => {});
      });

    return getStatus();
  }

  /** Wait for the in-flight initialize() to settle — tests only. */
  function settled() {
    return initPromise;
  }

  function ensureDataDir() {
    try {
      if (!fs.existsSync(opts.dataPath)) fs.mkdirSync(opts.dataPath, { recursive: true });
    } catch (err) {
      opts.log.warn({ err: err.message, dataPath: opts.dataPath }, 'could not create the whatsapp session directory');
    }
  }

  /**
   * Tear the client down and fail anything queued. Safe to call when nothing is
   * running — that is what the shutdown hook relies on.
   */
  async function destroy({ status = STATE.DISCONNECTED, quiet = false } = {}) {
    clearRetry();
    generation += 1; // orphan every event handler of the old client
    const dying = client;
    client = null;

    failQueue(REASON.SESSION_DOWN);
    numberIds.clear();

    if (dying) {
      try {
        await withTimeout(dying.destroy(), 15_000, 'whatsapp client destroy timed out');
      } catch (err) {
        opts.log.warn({ err: err.message }, 'whatsapp client destroy failed — dropping the reference anyway');
      }
    }

    setStatus(status, { qrDataUrl: null, qrAt: null, me: null });
    if (!quiet) opts.log.info('whatsapp client destroyed');
    return getStatus();
  }

  /** Destroy + fresh init. The "it has gone weird" button in Settings. */
  async function restart() {
    await destroy({ quiet: true });
    state.attempts = 0;
    return initialize({ reason: 'restart' });
  }

  /**
   * Unlink the session: log out of WhatsApp if we still can, then delete the
   * LocalAuth folder so the next initialize() starts from a fresh QR.
   */
  async function logout() {
    const dying = client;
    if (dying && typeof dying.logout === 'function') {
      try {
        await withTimeout(dying.logout(), 15_000, 'whatsapp logout timed out');
      } catch (err) {
        opts.log.warn({ err: err.message }, 'whatsapp logout failed — clearing the local session anyway');
      }
    }
    await destroy({ quiet: true });

    let removed = false;
    try {
      if (fs.existsSync(opts.dataPath)) {
        fs.rmSync(opts.dataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        removed = true;
      }
    } catch (err) {
      opts.log.warn({ err: err.message, dataPath: opts.dataPath }, 'could not delete the whatsapp session directory');
      recordError(`session files could not be deleted: ${err.message}`);
    }

    state.attempts = 0;
    state.lastReadyAt = null;
    opts.log.info({ removed, dataPath: opts.dataPath }, 'whatsapp session unlinked');
    return { ...getStatus(), removed };
  }

  // --- enable / disable -----------------------------------------------------

  function isEnabled() {
    return Boolean(config.getSetting(SETTING_ENABLED, false));
  }

  /**
   * Persist the toggle AND act on it. Enabling brings a client up; disabling
   * tears it down so no browser is left running and no reconnect is scheduled.
   */
  async function setEnabled(enabled) {
    const value = Boolean(enabled);
    config.setSetting(SETTING_ENABLED, value);
    if (value) {
      state.attempts = 0;
      await initialize({ reason: 'enabled' });
    } else {
      await destroy();
    }
    return getStatus();
  }

  /** Boot hook: only start when the admin has switched the channel on. */
  async function initializeIfEnabled() {
    if (!isEnabled()) {
      opts.log.info('whatsapp disabled — not starting a client');
      return getStatus();
    }
    return initialize({ reason: 'boot' });
  }

  // --- send queue -----------------------------------------------------------

  function failQueue(reason) {
    while (queue.length) {
      const job = queue.shift();
      job.reject(new Error(reason));
    }
  }

  /**
   * One message. Resolves with the delivered chat id, rejects with a plain
   * reason the engine can log. The promise is only settled once this job has
   * come off the queue, so callers naturally serialise.
   */
  function sendMessage(number, text) {
    let to;
    try {
      to = normalizeNumber(number);
    } catch (err) {
      return Promise.reject(err);
    }
    const body = String(text ?? '');
    if (!body.trim()) return Promise.reject(new Error('refusing to send an empty message'));

    return new Promise((resolve, reject) => {
      queue.push({ to, text: body, resolve, reject, queuedAt: opts.now() });
      drain().catch((err) => opts.log.error({ err: err.message }, 'whatsapp queue drain failed'));
    });
  }

  /** getNumberId() is a network round trip — ask once per number, then remember. */
  async function resolveNumberId(chatId) {
    if (numberIds.has(chatId)) {
      const cached = numberIds.get(chatId);
      if (!cached) throw new Error(`${chatId.replace('@c.us', '')} is not on WhatsApp`);
      return cached;
    }
    const bare = chatId.replace(/@c\.us$/, '');
    const found = await client.getNumberId(bare);
    const serialized = found ? found._serialized || `${found.user}@${found.server}` : null;
    numberIds.set(chatId, serialized);
    if (!serialized) throw new Error(`${bare} is not on WhatsApp`);
    return serialized;
  }

  async function deliver(job) {
    if (!client || !isReady()) throw new Error(REASON.SESSION_DOWN);
    const serialized = await withTimeout(
      resolveNumberId(job.to),
      opts.sendTimeoutMs,
      `whatsapp number lookup timed out after ${Math.round(opts.sendTimeoutMs / 1000)}s`
    );
    const result = await withTimeout(
      Promise.resolve(client.sendMessage(serialized, job.text)),
      opts.sendTimeoutMs,
      `whatsapp send timed out after ${Math.round(opts.sendTimeoutMs / 1000)}s`
    );
    lastSendAt = opts.now();
    const id = result && result.id ? result.id._serialized || result.id.id || null : null;
    return { to: serialized, id, at: isoNow() };
  }

  /**
   * Strictly one message in flight, with a randomised gap between consecutive
   * sends. A failed job never stalls the ones behind it.
   */
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const delay = nextDelay();
        const since = lastSendAt === null ? Infinity : opts.now() - lastSendAt;
        if (since < delay) await opts.sleep(delay - since);

        const job = queue.shift();
        if (!job) break;
        try {
          job.resolve(await deliver(job));
        } catch (err) {
          lastSendAt = opts.now(); // a failed attempt still counts as traffic
          opts.log.warn({ err: err.message, to: job.to }, 'whatsapp send failed');
          job.reject(err);
        }
      }
    } finally {
      draining = false;
    }
  }

  /** Settings → "send a test message". */
  async function sendTest(number) {
    const to = number || config.getSetting(SETTING_TEST_NUMBER, '') || '';
    if (!String(to).trim()) throw Object.assign(new Error('no test number given and none saved'), { status: 400 });
    if (!isReady()) throw Object.assign(new Error(REASON.SESSION_DOWN), { status: 409 });
    const when = new Date().toLocaleString('en-IN');
    const result = await sendMessage(to, `SG CRM test message — WhatsApp delivery is working. Sent ${when}.`);
    return { ok: true, ...result };
  }

  return {
    STATE,
    REASON,
    SETTING_ENABLED,
    SETTING_TEST_NUMBER,
    normalizeNumber,
    getStatus,
    isReady,
    isEnabled,
    setEnabled,
    initialize,
    initializeIfEnabled,
    restart,
    logout,
    destroy,
    sendMessage,
    sendTest,
    settled,
    // test seams
    _state: state,
    _queue: queue,
    _client: () => client,
  };
}

// ---------------------------------------------------------------------------
// the shared instance
// ---------------------------------------------------------------------------

let instance = createService();

/** Rebuild the shared instance with injected collaborators (tests only). */
function configure(overrides = {}) {
  instance = createService(overrides);
  return instance;
}

module.exports = {
  STATE,
  REASON,
  SETTING_ENABLED,
  SETTING_TEST_NUMBER,
  normalizeNumber,
  createService,
  configure,
  // delegate to whatever the current shared instance is
  getStatus: (...args) => instance.getStatus(...args),
  isReady: () => instance.isReady(),
  isEnabled: () => instance.isEnabled(),
  setEnabled: (...args) => instance.setEnabled(...args),
  initialize: (...args) => instance.initialize(...args),
  initializeIfEnabled: (...args) => instance.initializeIfEnabled(...args),
  restart: (...args) => instance.restart(...args),
  logout: (...args) => instance.logout(...args),
  destroy: (...args) => instance.destroy(...args),
  sendMessage: (...args) => instance.sendMessage(...args),
  sendTest: (...args) => instance.sendTest(...args),
  settled: () => instance.settled(),
};

// path is only used for the default data dir, kept out of the hot path
module.exports.defaultDataPath = () => path.resolve(config.WWEBJS_DIR);
