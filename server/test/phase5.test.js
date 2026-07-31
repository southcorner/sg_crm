'use strict';

/**
 * Phase 5 unit tests — the WhatsApp channel.
 *
 * The one rule this file obeys: **nothing here may load whatsapp-web.js or
 * launch a browser**. Every test drives an injected fake client, a fake QR
 * renderer, a fake clock, a fake sleep and a fake scheduler, so the state
 * machine, the send queue and the reconnect backoff are all exercised in
 * milliseconds and with no network at all.
 *
 *   npm test --workspace=server
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('node:events');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

// point config at a scratch database BEFORE anything requires it
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcrm-p5-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DATA_DIR = TMP_DIR;
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';
process.env.ENABLE_CRON = 'false';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const config = require('../src/config');
const whatsapp = require('../src/services/reminders/whatsapp');
const engine = require('../src/services/reminders/engine');

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Everything the service touches on a wweb.js Client, and nothing more. */
class FakeClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.initializeCalls = 0;
    this.destroyCalls = 0;
    this.logoutCalls = 0;
    this.numberIdCalls = [];
    this.sent = [];
    this.unknownNumbers = [];
    this.sendImpl = null;
    this.info = { pushname: 'SG CRM', wid: { user: '919999999999', _serialized: '919999999999@c.us' } };
  }

  async initialize() {
    this.initializeCalls += 1;
  }

  async destroy() {
    this.destroyCalls += 1;
  }

  async logout() {
    this.logoutCalls += 1;
  }

  async getNumberId(number) {
    this.numberIdCalls.push(number);
    if (this.unknownNumbers.includes(number)) return null;
    return { user: number, server: 'c.us', _serialized: `${number}@c.us` };
  }

  sendMessage(to, text) {
    this.sent.push({ to, text });
    if (this.sendImpl) return this.sendImpl(to, text);
    return Promise.resolve({ id: { _serialized: `msg-${this.sent.length}` } });
  }
}

/** setTimeout the tests can inspect and fire by hand. */
function fakeScheduler() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      if (handle) handle.cancelled = true;
    },
    /** Run the last still-live timer. */
    fire(index = scheduled.length - 1) {
      const handle = scheduled[index];
      assert.ok(handle, 'expected a scheduled timer');
      assert.equal(handle.cancelled, false, 'expected the timer to still be live');
      return handle.fn();
    },
  };
}

/** Let queued microtasks (the async event handlers) run. */
const tick = (times = 3) =>
  new Promise((resolve) => {
    let n = times;
    const step = () => (n-- <= 0 ? resolve() : setImmediate(step));
    step();
  });

/**
 * A service instance wired entirely to fakes. `clients` collects every client
 * the factory handed out, newest last — that is how the reconnect tests prove a
 * *fresh* client was built rather than the dead one reused.
 */
function makeService(overrides = {}) {
  const clients = [];
  const sleeps = [];
  const scheduler = fakeScheduler();
  const clock = { now: Date.parse('2026-08-10T09:00:00Z') };

  const service = whatsapp.createService({
    dataPath: path.join(TMP_DIR, 'wwebjs-test'),
    clientFactory: (opts) => {
      const client = new FakeClient(opts);
      clients.push(client);
      return client;
    },
    qrToDataUrl: async (text) => `data:image/png;base64,${Buffer.from(String(text)).toString('base64')}`,
    log: silentLog,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    scheduler,
    ...overrides,
  });

  return { service, clients, sleeps, scheduler, clock, last: () => clients[clients.length - 1] };
}

/** Bring a service all the way to `ready` with one fake client. */
async function readyService(overrides = {}) {
  const harness = makeService(overrides);
  await harness.service.initialize();
  harness.last().emit('ready');
  await tick();
  return harness;
}

// ---------------------------------------------------------------------------
// db fixtures (engine integration)
// ---------------------------------------------------------------------------

const TABLES = ['reminders_log', 'cheques', 'focus_plans', 'invoices', 'customers', 'salespersons'];

function resetDb() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('cheques','focus_plans','reminders_log')");
  db.exec('PRAGMA foreign_keys = ON');
}

function addRep(id, name, { email = null, notifyEmail = 1, whatsappNumber = null, notifyWhatsapp = 0 } = {}) {
  getDb()
    .prepare(
      `INSERT INTO salespersons (zoho_salesperson_id, name, crm_email, notify_email, whatsapp_number, notify_whatsapp, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(id, name, email ?? `${id.toLowerCase()}@example.in`, notifyEmail, whatsappNumber, notifyWhatsapp);
  return id;
}

function addCustomer(id, name) {
  getDb().prepare('INSERT INTO customers (zoho_contact_id, contact_name, status) VALUES (?, ?, ?)').run(id, name, 'active');
  return id;
}

function addOverdueInvoice(id, { customer, rep, due, balance = 5000, number = id }) {
  getDb()
    .prepare(
      `INSERT INTO invoices (zoho_invoice_id, invoice_number, customer_id, customer_name, salesperson_id,
         invoice_date, due_date, status, total, sub_total, balance)
       VALUES (?, ?, ?, (SELECT contact_name FROM customers WHERE zoho_contact_id = ?), ?, ?, ?, 'sent', ?, ?, ?)`
    )
    .run(id, number, customer, customer, rep, due, due, balance, balance, balance);
  return id;
}

function logRows(where = '1=1') {
  return getDb()
    .prepare(`SELECT rule_type, channel, status, detail FROM reminders_log WHERE ${where} ORDER BY id ASC`)
    .all()
    .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

/** An email sender that records instead of sending. */
function fakeEmailSender() {
  const sent = [];
  return {
    sent,
    fn: async (digest) => {
      sent.push(digest);
      return { to: digest.rep.email, messageId: `<fake-${digest.rep.id}>` };
    },
  };
}

before(() => {
  runMigrations();
  config.seedSettingDefaults();
});

after(async () => {
  await whatsapp.destroy().catch(() => {});
  closeDb();
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* windows may still hold the wal file — harmless in a scratch dir */
  }
});

beforeEach(() => {
  resetDb();
  config.setSetting('whatsapp_enabled', false);
  config.setSetting('overdue_min_days', 1);
  config.setSetting('overdue_min_amount', 0);
  config.setSetting('overdue_resend_days', 7);
  config.setSetting('dormant_months', 3);
  config.setSetting('cheque_lead_days', 3);
});

// ===========================================================================
// number normalisation
// ===========================================================================

describe('normalizeNumber: what a rep may type vs what wweb.js needs', () => {
  const cases = [
    ['+91 98765 43210', '919876543210@c.us'],
    ['+919876543210', '919876543210@c.us'],
    ['09876543210', '919876543210@c.us'],
    ['9876543210', '919876543210@c.us'],
    ['98765 43210', '919876543210@c.us'],
    ['919876543210', '919876543210@c.us'],
    ['919876543210@c.us', '919876543210@c.us'],
    ['0091 98765 43210', '919876543210@c.us'],
    ['(987) 654-3210', '919876543210@c.us'],
    ['+44 7700 900123', '447700900123@c.us'], // already carries a country code
  ];

  for (const [input, expected] of cases) {
    test(`${input} → ${expected}`, () => {
      assert.equal(whatsapp.normalizeNumber(input), expected);
    });
  }

  test('fewer than ten digits is a typo, not a number', () => {
    for (const bad of ['12345', '98765 4321', '+91 98765', '0', 'abc']) {
      assert.throws(() => whatsapp.normalizeNumber(bad), /not a usable whatsapp number/, `expected ${bad} to be rejected`);
    }
  });

  test('an empty value is rejected before anything is queued', () => {
    assert.throws(() => whatsapp.normalizeNumber(''), /no whatsapp number/);
    assert.throws(() => whatsapp.normalizeNumber(null), /no whatsapp number/);
  });
});

// ===========================================================================
// state machine
// ===========================================================================

describe('state machine: disconnected → qr_pending → ready', () => {
  test('a fresh service is disconnected and has launched nothing', () => {
    const { service, clients } = makeService();
    assert.equal(service.getStatus().state, 'disconnected');
    assert.equal(clients.length, 0);
  });

  test('initialize() builds one client and reports initializing', async () => {
    const { service, clients } = makeService();
    const status = await service.initialize();
    assert.equal(status.state, 'initializing');
    assert.equal(clients.length, 1);
    assert.equal(clients[0].initializeCalls, 1);
  });

  test('a qr event becomes a data-URL the Settings page can render', async () => {
    const { service, last } = await Promise.resolve(makeService()).then(async (h) => {
      await h.service.initialize();
      return h;
    });
    last().emit('qr', 'WA-QR-PAYLOAD');
    await tick();

    const status = service.getStatus();
    assert.equal(status.state, 'qr_pending');
    assert.match(status.qrDataUrl, /^data:image\/png;base64,/);
    assert.equal(Buffer.from(status.qrDataUrl.split(',')[1], 'base64').toString(), 'WA-QR-PAYLOAD');
    assert.ok(status.qrAt);
  });

  test('ready clears the QR, stamps lastReadyAt and records the linked number', async () => {
    const { service, last } = makeService();
    await service.initialize();
    last().emit('qr', 'WA-QR-PAYLOAD');
    await tick();
    last().emit('ready');
    await tick();

    const status = service.getStatus();
    assert.equal(status.state, 'ready');
    assert.equal(status.ready, true);
    assert.equal(status.qrDataUrl, null);
    assert.ok(status.lastReadyAt);
    assert.equal(status.me.number, '919999999999');
  });

  test('the QR is only handed out while it is pending', async () => {
    const { service, last } = makeService();
    await service.initialize();
    last().emit('qr', 'WA-QR-PAYLOAD');
    await tick();
    assert.ok(service.getStatus({ includeQr: false }).qrDataUrl === null);
    assert.equal(service.getStatus({ includeQr: false }).hasQr, true);
  });

  test('authenticated is reported between the scan and ready', async () => {
    const { service, last } = makeService();
    await service.initialize();
    last().emit('authenticated');
    await tick();
    assert.equal(service.getStatus().state, 'authenticated');
  });

  test('initialize() is idempotent — a second call never opens a second browser', async () => {
    const { service, clients } = makeService();
    await service.initialize();
    await service.initialize();
    assert.equal(clients.length, 1);
  });
});

describe('state machine: losing the session', () => {
  beforeEach(() => config.setSetting('whatsapp_enabled', true));

  test('a disconnect destroys the client and schedules a reconnect 30s out', async () => {
    const { service, clients, scheduler } = await readyService();
    clients[0].emit('disconnected', 'NAVIGATION');
    await tick();

    const status = service.getStatus();
    assert.equal(status.state, 'disconnected');
    assert.match(status.lastError, /disconnected: NAVIGATION/);
    assert.equal(clients[0].destroyCalls, 1);
    assert.equal(scheduler.scheduled.length, 1);
    assert.equal(scheduler.scheduled[0].ms, 30_000);
    assert.ok(status.nextRetryAt);
  });

  test('firing the retry builds a FRESH client, not the dead one', async () => {
    const { service, clients, scheduler } = await readyService();
    clients[0].emit('disconnected', 'LOGOUT');
    await tick();
    await scheduler.fire();
    await tick();

    assert.equal(clients.length, 2);
    assert.notEqual(clients[1], clients[0]);
    assert.equal(service.getStatus().state, 'initializing');
  });

  test('the backoff doubles 30s → 1m → 2m and caps at 10m', async () => {
    const { service, clients, scheduler } = await readyService();
    const expected = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000];

    for (let i = 0; i < expected.length; i += 1) {
      clients[clients.length - 1].emit('disconnected', `drop-${i}`);
      await tick();
      assert.equal(scheduler.scheduled[i].ms, expected[i], `attempt ${i + 1}`);
      await scheduler.fire(i);
      await tick();
    }
    assert.equal(service.getStatus().attempts, expected.length);
  });

  test('a session that comes back resets the backoff', async () => {
    const { service, clients, scheduler } = await readyService();
    clients[0].emit('disconnected', 'drop');
    await tick();
    await scheduler.fire();
    await tick();
    clients[1].emit('ready');
    await tick();

    assert.equal(service.getStatus().attempts, 0);
    assert.equal(service.getStatus().state, 'ready');

    clients[1].emit('disconnected', 'drop again');
    await tick();
    assert.equal(scheduler.scheduled[scheduler.scheduled.length - 1].ms, 30_000);
  });

  test('auth_failure is treated as a lost session', async () => {
    const { service, clients, scheduler } = await readyService();
    clients[0].emit('auth_failure', 'session file rejected');
    await tick();
    assert.equal(service.getStatus().state, 'disconnected');
    assert.match(service.getStatus().lastError, /auth_failure/);
    assert.equal(scheduler.scheduled.length, 1);
  });

  test('a disconnect while the channel is disabled schedules nothing', async () => {
    const { service, clients, scheduler } = await readyService();
    config.setSetting('whatsapp_enabled', false);
    clients[0].emit('disconnected', 'admin turned it off');
    await tick();
    assert.equal(scheduler.scheduled.length, 0);
    assert.equal(service.getStatus().state, 'disconnected');
  });

  test('an event from a destroyed client is ignored', async () => {
    const { service, clients } = await readyService();
    const dead = clients[0];
    await service.destroy();
    dead.emit('qr', 'ZOMBIE');
    await tick();
    assert.equal(service.getStatus().state, 'disconnected');
    assert.equal(service.getStatus().hasQr, false);
  });
});

describe('lifecycle controls', () => {
  test('restart destroys the old client and starts a new one', async () => {
    const { service, clients } = await readyService();
    await service.restart();
    assert.equal(clients.length, 2);
    assert.equal(clients[0].destroyCalls, 1);
    assert.equal(service.getStatus().state, 'initializing');
  });

  test('logout unlinks the phone and deletes the session directory', async () => {
    const dataPath = path.join(TMP_DIR, `wwebjs-logout-${Date.now()}`);
    const { service, clients } = await readyService({ dataPath });
    fs.mkdirSync(path.join(dataPath, 'session-sg-crm'), { recursive: true });
    fs.writeFileSync(path.join(dataPath, 'session-sg-crm', 'creds'), 'x');

    const result = await service.logout();
    assert.equal(clients[0].logoutCalls, 1);
    assert.equal(clients[0].destroyCalls, 1);
    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(dataPath), false);
    assert.equal(service.getStatus().state, 'disconnected');
    assert.equal(service.getStatus().lastReadyAt, null);
  });

  test('destroy on a service that never started is a no-op', async () => {
    const { service, clients } = makeService();
    const status = await service.destroy();
    assert.equal(status.state, 'disconnected');
    assert.equal(clients.length, 0);
  });

  test('initializeIfEnabled respects the setting', async () => {
    config.setSetting('whatsapp_enabled', false);
    const off = makeService();
    await off.service.initializeIfEnabled();
    assert.equal(off.clients.length, 0);

    config.setSetting('whatsapp_enabled', true);
    const on = makeService();
    await on.service.initializeIfEnabled();
    assert.equal(on.clients.length, 1);
  });
});

// ===========================================================================
// enable / disable persistence
// ===========================================================================

describe('enable/disable: the setting and the client move together', () => {
  test('enabling persists the flag and brings a client up; disabling tears it down', async () => {
    const { service, clients, last } = makeService();

    await service.setEnabled(true);
    assert.equal(config.getSetting('whatsapp_enabled'), true);
    assert.equal(clients.length, 1);

    last().emit('qr', 'PAIR-ME');
    await tick();
    assert.equal(service.getStatus().state, 'qr_pending');
    assert.ok(service.getStatus().qrDataUrl);

    await service.setEnabled(false);
    assert.equal(config.getSetting('whatsapp_enabled'), false);
    assert.equal(clients[0].destroyCalls, 1);
    const status = service.getStatus();
    assert.equal(status.state, 'disconnected');
    assert.equal(status.enabled, false);
    assert.equal(status.qrDataUrl, null);
  });

  test('disabling cancels a pending reconnect', async () => {
    config.setSetting('whatsapp_enabled', true);
    const { service, clients, scheduler } = await readyService();
    clients[0].emit('disconnected', 'drop');
    await tick();
    assert.equal(scheduler.scheduled.length, 1);

    await service.setEnabled(false);
    assert.equal(scheduler.scheduled[0].cancelled, true);
    assert.equal(service.getStatus().nextRetryAt, null);
  });
});

// ===========================================================================
// send queue
// ===========================================================================

describe('send queue: one message at a time, with a gap', () => {
  test('the second send waits for the first to finish', async () => {
    const { service, last } = await readyService();
    const client = last();

    let releaseFirst;
    client.sendImpl = () => new Promise((resolve) => {
      releaseFirst = () => resolve({ id: { _serialized: 'msg-1' } });
    });

    const first = service.sendMessage('9876543210', 'one');
    await tick();
    const second = service.sendMessage('9876543211', 'two');
    await tick();

    assert.equal(client.sent.length, 1, 'only the first message may be in flight');
    assert.equal(service.getStatus().queue, 1);

    client.sendImpl = null;
    releaseFirst();
    await first;
    await second;
    assert.deepEqual(client.sent.map((m) => m.text), ['one', 'two']);
  });

  test('consecutive sends are spaced by a random 4–8 second gap', async () => {
    const { service, sleeps, last } = await readyService();
    await service.sendMessage('9876543210', 'one');
    await service.sendMessage('9876543210', 'two');
    await service.sendMessage('9876543210', 'three');

    assert.equal(last().sent.length, 3);
    assert.equal(sleeps.length, 2, 'no delay before the first message, one before each of the rest');
    for (const ms of sleeps) {
      assert.ok(ms >= 4000 && ms <= 8000, `expected a 4–8s gap, got ${ms}ms`);
    }
  });

  test('a hung send is killed by the timeout and the queue keeps moving', async () => {
    const { service, last } = await readyService({ sendTimeoutMs: 25 });
    const client = last();
    client.sendImpl = () => new Promise(() => {}); // never settles

    await assert.rejects(service.sendMessage('9876543210', 'hangs'), /timed out after/);

    client.sendImpl = null;
    const result = await service.sendMessage('9876543210', 'goes through');
    assert.equal(result.to, '919876543210@c.us');
    assert.equal(client.sent[client.sent.length - 1].text, 'goes through');
    assert.equal(service.getStatus().queue, 0);
  });

  test('a send with no session fails fast rather than queueing forever', async () => {
    const { service } = makeService();
    await assert.rejects(service.sendMessage('9876543210', 'nope'), /session_down/);
  });

  test('destroying the client rejects everything still queued', async () => {
    const { service, last } = await readyService();
    const client = last();
    client.sendImpl = () => new Promise(() => {});

    const first = service.sendMessage('9876543210', 'in flight');
    await tick();
    const queued = service.sendMessage('9876543211', 'queued');
    await tick();

    await service.destroy();
    await assert.rejects(queued, /session_down/);
    first.catch(() => {}); // the in-flight one stays pending on the dead page
  });

  test('a bad number never reaches the queue', async () => {
    const { service, last } = await readyService();
    await assert.rejects(service.sendMessage('12345', 'nope'), /not a usable whatsapp number/);
    assert.equal(last().sent.length, 0);
  });
});

describe('send queue: number validation', () => {
  test('getNumberId is asked once per number and then remembered', async () => {
    const { service, last } = await readyService();
    await service.sendMessage('+91 98765 43210', 'one');
    await service.sendMessage('09876543210', 'two'); // same number, written differently
    await service.sendMessage('9876543211', 'three');

    assert.deepEqual(last().numberIdCalls, ['919876543210', '919876543211']);
    assert.equal(last().sent.length, 3);
  });

  test('a number that is not on WhatsApp fails with a clear error', async () => {
    const { service, last } = await readyService();
    last().unknownNumbers = ['919876543210'];
    await assert.rejects(service.sendMessage('9876543210', 'hello'), /919876543210 is not on WhatsApp/);
    assert.equal(last().sent.length, 0);
  });

  test('the "not on WhatsApp" answer is cached too', async () => {
    const { service, last } = await readyService();
    last().unknownNumbers = ['919876543210'];
    await service.sendMessage('9876543210', 'a').catch(() => {});
    await service.sendMessage('9876543210', 'b').catch(() => {});
    assert.equal(last().numberIdCalls.length, 1);
  });
});

// ===========================================================================
// engine integration
// ===========================================================================

describe('engine: whatsapp as a second channel', () => {
  const RUN = '2026-08-10';

  /** Swap the shared instance for a fake and (optionally) drive it to ready. */
  async function useSharedFake({ ready = true } = {}) {
    const clients = [];
    whatsapp.configure({
      dataPath: path.join(TMP_DIR, 'wwebjs-shared'),
      clientFactory: (opts) => {
        const client = new FakeClient(opts);
        clients.push(client);
        return client;
      },
      qrToDataUrl: async (text) => `data:image/png;base64,${Buffer.from(String(text)).toString('base64')}`,
      log: silentLog,
      sleep: async () => {},
      scheduler: fakeScheduler(),
    });
    config.setSetting('whatsapp_enabled', true);
    await whatsapp.initialize();
    if (ready) {
      clients[clients.length - 1].emit('ready');
      await tick();
    }
    return clients;
  }

  beforeEach(() => {
    addCustomer('C1', 'Sharma Cycle Mart');
  });

  after(() => {
    whatsapp.configure(); // back to the real (unstarted) client factory
  });

  /** The real whatsapp sender, an email sender that only records. */
  function senders() {
    const mail = fakeEmailSender();
    return { mail, registry: { ...engine.defaultSenders(), email: mail.fn } };
  }

  test('a ready session + a number + the opt-in ⇒ the plain-text digest is sent', async () => {
    const clients = await useSharedFake();
    addRep('SP1', 'Anil Mehta', { whatsappNumber: '9876543210', notifyWhatsapp: 1 });
    addOverdueInvoice('I-1', { customer: 'C1', rep: 'SP1', due: '2026-07-01', balance: 12000, number: 'INV-1' });

    const { mail, registry } = senders();
    const result = await engine.run({ date: RUN, senders: registry });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, 'sent');
    assert.deepEqual(
      result.results[0].channels.map((c) => [c.channel, c.status]),
      [['email', 'sent'], ['whatsapp', 'sent']]
    );

    const client = clients[clients.length - 1];
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].to, '919876543210@c.us');
    // exactly the digest's plain-text body — no HTML on WhatsApp
    assert.match(client.sent[0].text, /Anil Mehta — SG CRM digest/);
    assert.match(client.sent[0].text, /OVERDUE/);
    assert.equal(mail.sent.length, 1);

    // one row per item per channel; the digest row carries both channels at once
    const wa = logRows("channel = 'whatsapp'");
    assert.equal(wa.length, 1);
    assert.equal(wa[0].rule_type, 'overdue');
    assert.equal(wa[0].status, 'sent');
    const digestRow = logRows("rule_type = 'digest'")[0];
    assert.equal(digestRow.channel, 'email,whatsapp');
    assert.deepEqual(
      digestRow.detail.channels.map((c) => [c.channel, c.status]),
      [['email', 'sent'], ['whatsapp', 'sent']]
    );
  });

  test('session down ⇒ whatsapp fails with session_down and the email still goes', async () => {
    const clients = await useSharedFake({ ready: false }); // stuck at initializing
    assert.equal(clients.length, 1);
    addRep('SP1', 'Anil Mehta', { whatsappNumber: '9876543210', notifyWhatsapp: 1 });
    addOverdueInvoice('I-1', { customer: 'C1', rep: 'SP1', due: '2026-07-01', balance: 12000, number: 'INV-1' });

    const { mail, registry } = senders();
    const result = await engine.run({ date: RUN, senders: registry });

    assert.equal(result.results[0].status, 'sent', 'the digest counts as sent because email went');
    const wa = result.results[0].channels.find((c) => c.channel === 'whatsapp');
    assert.equal(wa.status, 'failed');
    assert.equal(wa.error, 'session_down');
    assert.equal(mail.sent.length, 1);
    assert.equal(clients[0].sent.length, 0);

    const failed = logRows("channel = 'whatsapp' AND status = 'failed'");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].detail.error, 'session_down');
    // the same item on the email channel is recorded as sent
    assert.deepEqual(
      logRows("channel = 'email' AND rule_type = 'overdue'").map((r) => r.status),
      ['sent']
    );

    // ...and the dashboard/banner can see it
    const status = engine.digestStatus({ date: RUN });
    assert.equal(status.today.whatsappDown, true);
    assert.equal(status.today.sent, 1);
  });

  test('a rep who opted out is logged as opted_out, not silently skipped', async () => {
    await useSharedFake();
    addRep('SP1', 'Anil Mehta', { whatsappNumber: '9876543210', notifyWhatsapp: 0 });
    addOverdueInvoice('I-1', { customer: 'C1', rep: 'SP1', due: '2026-07-01', balance: 9000, number: 'INV-1' });

    const { registry } = senders();
    const result = await engine.run({ date: RUN, senders: registry });
    const wa = result.results[0].channels.find((c) => c.channel === 'whatsapp');
    assert.equal(wa.status, 'failed');
    assert.equal(wa.error, 'opted_out');
    assert.equal(engine.digestStatus({ date: RUN }).today.whatsappDown, false);
  });

  test('a rep with the opt-in but no number is logged as no_number', async () => {
    await useSharedFake();
    addRep('SP1', 'Anil Mehta', { whatsappNumber: null, notifyWhatsapp: 1 });
    addOverdueInvoice('I-1', { customer: 'C1', rep: 'SP1', due: '2026-07-01', balance: 9000, number: 'INV-1' });

    const { registry } = senders();
    const result = await engine.run({ date: RUN, senders: registry });
    const wa = result.results[0].channels.find((c) => c.channel === 'whatsapp');
    assert.equal(wa.status, 'failed');
    assert.equal(wa.error, 'no_number');
  });

  test('with the channel disabled nothing whatsapp-shaped is even attempted', async () => {
    await useSharedFake();
    config.setSetting('whatsapp_enabled', false);
    addRep('SP1', 'Anil Mehta', { whatsappNumber: '9876543210', notifyWhatsapp: 1 });
    addOverdueInvoice('I-1', { customer: 'C1', rep: 'SP1', due: '2026-07-01', balance: 9000, number: 'INV-1' });

    const { registry } = senders();
    const result = await engine.run({ date: RUN, senders: registry });
    assert.deepEqual(result.results[0].channels.map((c) => c.channel), ['email']);
    assert.equal(logRows("channel = 'whatsapp'").length, 0);
  });

  test('a whatsapp-only rep (no email) still gets the digest', async () => {
    const clients = await useSharedFake();
    addRep('SP1', 'Anil Mehta', { notifyEmail: 0, whatsappNumber: '9876543210', notifyWhatsapp: 1 });
    addOverdueInvoice('I-1', { customer: 'C1', rep: 'SP1', due: '2026-07-01', balance: 9000, number: 'INV-1' });

    const { mail, registry } = senders();
    const result = await engine.run({ date: RUN, senders: registry });
    assert.deepEqual(result.results[0].channels.map((c) => [c.channel, c.status]), [['whatsapp', 'sent']]);
    assert.equal(mail.sent.length, 0);
    assert.equal(clients[clients.length - 1].sent.length, 1);
  });

  test('a failed whatsapp row never blocks tomorrow — no stale retry, no dedupe damage', async () => {
    await useSharedFake({ ready: false });
    addRep('SP1', 'Anil Mehta', { whatsappNumber: '9876543210', notifyWhatsapp: 1 });
    addOverdueInvoice('I-1', { customer: 'C1', rep: 'SP1', due: '2026-07-01', balance: 9000, number: 'INV-1' });

    await engine.run({ date: RUN, senders: senders().registry });

    // the invoice was emailed today, so the resend window (7d) holds it back
    // tomorrow — and the failed whatsapp row changes nothing about that
    const tomorrow = engine.overdueRule(engine.addDays(RUN, 1), engine.settingsSnapshot());
    assert.equal(tomorrow.groups.length, 0);
    assert.equal(tomorrow.suppressed.length, 1);

    const later = engine.overdueRule(engine.addDays(RUN, 8), engine.settingsSnapshot());
    assert.equal(later.groups.length, 1);
  });
});
