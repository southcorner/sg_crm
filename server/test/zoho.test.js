'use strict';

/**
 * Zoho client + sync unit tests (no network, no live credentials).
 *
 * The HTTP layer is injected as a fake `fetch`, the API-call counter is an
 * in-memory one and the database is a throwaway SQLite file under
 * server/test/tmp/. Run with:  npm test --workspace=server
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

// point config at a scratch database BEFORE anything requires it
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcrm-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DATA_DIR = TMP_DIR;
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const config = require('../src/config');
const {
  ZohoClient,
  BudgetExceededError,
  ZohoApiError,
  memoryCallCounter,
  TokenBucket,
} = require('../src/zoho/client');
const sync = require('../src/zoho/sync');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

/** Fake fetch that records every call and delegates to `handler`. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    const u = new URL(url);
    const call = {
      url: u,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      opts,
    };
    calls.push(call);
    return handler(call, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function makeClient(handler, { budget = 1000, maxRetries = 3 } = {}) {
  const sleeps = [];
  const fetchImpl = fakeFetch(handler);
  const tokenCalls = [];
  const client = new ZohoClient({
    fetchImpl,
    getToken: async (opts) => {
      tokenCalls.push(opts || {});
      return 'test-access-token';
    },
    getOrgId: () => '60000000123',
    counter: memoryCallCounter(budget),
    maxRetries,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    rateLimit: { capacity: 10_000, windowMs: 60_000 },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  });
  client.__fetch = fetchImpl;
  client.__sleeps = sleeps;
  client.__tokenCalls = tokenCalls;
  return client;
}

function contact(i, lastModified) {
  return {
    contact_id: `C${i}`,
    contact_name: `Customer ${i}`,
    company_name: `Customer ${i} Pvt Ltd`,
    email: `c${i}@example.in`,
    mobile: `90000000${String(i).padStart(2, '0')}`,
    contact_type: 'customer',
    status: 'active',
    outstanding_receivable_amount: i * 100,
    last_modified_time: lastModified || '2026-07-20T10:00:00+0530',
  };
}

function invoice(i, overrides = {}) {
  return {
    invoice_id: `I${i}`,
    invoice_number: `INV-${1000 + i}`,
    customer_id: `C1`,
    customer_name: 'Customer 1',
    salesperson_id: 'SP1',
    salesperson_name: 'Anil Mehta',
    date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
    due_date: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
    status: 'sent',
    total: 1000 + i,
    balance: 1000 + i,
    last_modified_time: '2026-07-20T10:00:00+0530',
    ...overrides,
  };
}

function page(listKey, rows, hasMore, pageNo) {
  return { code: 0, message: 'success', [listKey]: rows, page_context: { page: pageNo, per_page: 200, has_more_page: hasMore } };
}

function resetDb() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['invoice_line_items', 'payments', 'invoices', 'items', 'customers', 'salespersons', 'sync_state']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.exec('PRAGMA foreign_keys = ON');
}

const count = (table) => getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

before(() => {
  runMigrations();
  config.seedSettingDefaults();
});

after(() => {
  closeDb();
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* windows may still hold the wal file — harmless in a scratch dir */
  }
});

beforeEach(() => {
  resetDb();
});

// ---------------------------------------------------------------------------

describe('time helpers', () => {
  test('formats IST with a +0530 offset', () => {
    // 2026-07-31T04:30:00Z === 10:00 IST
    assert.equal(sync.toZohoTime(new Date('2026-07-31T04:30:00Z')), '2026-07-31T10:00:00+0530');
  });

  test('parses both +0530 and +05:30 forms', () => {
    const a = sync.parseZohoTime('2026-07-31T10:00:00+0530');
    const b = sync.parseZohoTime('2026-07-31T10:00:00+05:30');
    assert.equal(a.getTime(), b.getTime());
    assert.equal(a.toISOString(), '2026-07-31T04:30:00.000Z');
  });
});

describe('client: pagination', () => {
  test('follows has_more_page until the last page and collects every row', async () => {
    const p1 = Array.from({ length: 200 }, (_, i) => contact(i + 1));
    const p2 = Array.from({ length: 50 }, (_, i) => contact(i + 201));
    const client = makeClient(({ query }) =>
      jsonResponse(query.page === '1' ? page('contacts', p1, true, 1) : page('contacts', p2, false, 2))
    );

    const rows = await client.paginate('/contacts', { listKey: 'contacts', query: { contact_type: 'customer' } });

    assert.equal(rows.length, 250);
    assert.equal(client.__fetch.calls.length, 2);
    assert.equal(client.__fetch.calls[0].query.page, '1');
    assert.equal(client.__fetch.calls[0].query.per_page, '200');
    assert.equal(client.__fetch.calls[1].query.page, '2');
    // every call carries the org id and the bearer header
    for (const call of client.__fetch.calls) {
      assert.equal(call.query.organization_id, '60000000123');
      assert.equal(call.opts.headers.Authorization, 'Zoho-oauthtoken test-access-token');
      assert.equal(call.query.contact_type, 'customer');
    }
  });

  test('stops on an empty page even if has_more_page stays true', async () => {
    const client = makeClient(({ query }) =>
      jsonResponse(query.page === '1' ? page('items', [{ item_id: 'X1', name: 'x' }], true, 1) : page('items', [], true, 2))
    );
    const rows = await client.paginate('/items', { listKey: 'items' });
    assert.equal(rows.length, 1);
    assert.equal(client.__fetch.calls.length, 2);
  });
});

describe('client: retries and budget', () => {
  test('retries a 429 with backoff and then succeeds', async () => {
    let attempts = 0;
    const client = makeClient(() => {
      attempts += 1;
      if (attempts <= 2) return jsonResponse({ message: 'rate limited' }, { status: 429 });
      return jsonResponse(page('invoices', [invoice(1)], false, 1));
    });

    const payload = await client.get('/invoices');
    assert.equal(attempts, 3);
    assert.equal(payload.invoices.length, 1);
    assert.deepEqual(client.__sleeps, [500, 1000]); // exponential backoff
  });

  test('honours a Retry-After header', async () => {
    let attempts = 0;
    const client = makeClient(() => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({}, { status: 429, headers: { 'Retry-After': '3' } });
      return jsonResponse(page('invoices', [], false, 1));
    });
    await client.get('/invoices');
    assert.deepEqual(client.__sleeps, [3000]);
  });

  test('gives up after maxRetries on repeated 5xx', async () => {
    const client = makeClient(() => jsonResponse({ message: 'boom' }, { status: 500 }));
    await assert.rejects(() => client.get('/invoices'), (err) => {
      assert.ok(err instanceof ZohoApiError);
      assert.equal(err.status, 500);
      return true;
    });
    assert.equal(client.__fetch.calls.length, 4); // 1 attempt + 3 retries
  });

  test('refreshes the token once on a 401 and retries', async () => {
    let attempts = 0;
    const client = makeClient(() => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ message: 'invalid token' }, { status: 401 });
      return jsonResponse(page('items', [], false, 1));
    });

    await client.get('/items');
    assert.equal(attempts, 2);
    assert.ok(client.__tokenCalls.some((c) => c.force === true), 'expected a forced token refresh');
  });

  test('throws BudgetExceededError once the daily budget is spent', async () => {
    const client = makeClient(() => jsonResponse(page('items', [{ item_id: 'X', name: 'x' }], false, 1)), {
      budget: 2,
    });

    await client.get('/items');
    await client.get('/items');
    await assert.rejects(() => client.get('/items'), (err) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.budget, 2);
      assert.equal(err.used, 2);
      return true;
    });
    assert.equal(client.__fetch.calls.length, 2, 'no HTTP call is made once the budget is gone');
  });

  test('token bucket blocks past its capacity until refill', async () => {
    let clock = 0;
    const slept = [];
    const bucket = new TokenBucket({
      capacity: 2,
      windowMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await bucket.take();
    await bucket.take();
    await bucket.take(); // must wait for a refill
    assert.ok(slept.length >= 1, 'third take should have waited');
  });
});

describe('sync: entity list sync', () => {
  test('full backfill sends no last_modified_time and stores a cursor', async () => {
    const client = makeClient(() => jsonResponse(page('contacts', [contact(1), contact(2)], false, 1)));

    const result = await sync.syncEntity('customers', { client });

    assert.equal(result.mode, 'full');
    assert.equal(result.fetched, 2);
    assert.equal(count('customers'), 2);
    assert.equal(client.__fetch.calls[0].query.last_modified_time, undefined);
    const state = sync.getSyncState('customers');
    assert.equal(state.last_status, 'ok');
    assert.match(state.cursor, /\+0530$/);
  });

  test('incremental run asks for cursor minus the 5-minute overlap', async () => {
    const client1 = makeClient(() =>
      jsonResponse(page('contacts', [contact(1, '2026-07-25T12:00:00+0530')], false, 1))
    );
    await sync.syncEntity('customers', { client: client1 });
    assert.equal(sync.getSyncState('customers').cursor, '2026-07-25T12:00:00+0530');

    const client2 = makeClient(() => jsonResponse(page('contacts', [], false, 1)));
    const result = await sync.syncEntity('customers', { client: client2 });

    assert.equal(result.mode, 'incremental');
    assert.equal(client2.__fetch.calls[0].query.last_modified_time, '2026-07-25T11:55:00+0530');
  });

  test('cursor never moves backwards when older records come back', async () => {
    const client1 = makeClient(() =>
      jsonResponse(page('contacts', [contact(1, '2026-07-25T12:00:00+0530')], false, 1))
    );
    await sync.syncEntity('customers', { client: client1 });

    const client2 = makeClient(() =>
      jsonResponse(page('contacts', [contact(2, '2026-07-25T11:57:00+0530')], false, 1))
    );
    await sync.syncEntity('customers', { client: client2 });

    assert.equal(sync.getSyncState('customers').cursor, '2026-07-25T12:00:00+0530');
  });

  test('upserts are idempotent — running twice leaves the same row count', async () => {
    const rows = [contact(1), contact(2), contact(3)];
    const client = makeClient(() => jsonResponse(page('contacts', rows, false, 1)));

    await sync.syncEntity('customers', { client });
    const first = count('customers');
    await sync.syncEntity('customers', { client });
    const second = count('customers');

    assert.equal(first, 3);
    assert.equal(second, 3);
  });

  test('re-syncing an updated row overwrites the fields but keeps one row', async () => {
    const c = contact(1, '2026-07-20T10:00:00+0530');
    const client1 = makeClient(() => jsonResponse(page('contacts', [c], false, 1)));
    await sync.syncEntity('customers', { client: client1 });

    const updated = { ...c, contact_name: 'Renamed Customer', outstanding_receivable_amount: 5555, last_modified_time: '2026-07-26T10:00:00+0530' };
    const client2 = makeClient(() => jsonResponse(page('contacts', [updated], false, 1)));
    await sync.syncEntity('customers', { client: client2 });

    const row = getDb().prepare('SELECT * FROM customers WHERE zoho_contact_id = ?').get('C1');
    assert.equal(count('customers'), 1);
    assert.equal(row.contact_name, 'Renamed Customer');
    assert.equal(row.outstanding_receivable, 5555);
  });

  test('salespersons full refresh never clobbers CRM-owned columns', async () => {
    const sp = { salesperson_id: 'SP1', salesperson_name: 'Anil Mehta', salesperson_email: 'anil@example.in' };
    const client = makeClient(() => jsonResponse(page('salespersons', [sp], false, 1)));
    await sync.syncEntity('salespersons', { client });

    getDb()
      .prepare(
        `UPDATE salespersons SET crm_email = 'anil.crm@example.in', whatsapp_number = '919999999999', notify_whatsapp = 1 WHERE zoho_salesperson_id = 'SP1'`
      )
      .run();

    const client2 = makeClient(() =>
      jsonResponse(page('salespersons', [{ ...sp, salesperson_name: 'Anil M.' }], false, 1))
    );
    await sync.syncEntity('salespersons', { client: client2 });

    const row = getDb().prepare('SELECT * FROM salespersons WHERE zoho_salesperson_id = ?').get('SP1');
    assert.equal(row.name, 'Anil M.');
    assert.equal(row.crm_email, 'anil.crm@example.in');
    assert.equal(row.whatsapp_number, '919999999999');
    assert.equal(row.notify_whatsapp, 1);
    // a full-refresh entity is never filtered by last_modified_time
    assert.equal(client2.__fetch.calls[0].query.last_modified_time, undefined);
  });

  test('an edited invoice is re-queued for the line-item pass', async () => {
    const inv = invoice(1);
    const client = makeClient(() => jsonResponse(page('invoices', [inv], false, 1)));
    await sync.syncEntity('invoices', { client });
    getDb().prepare('UPDATE invoices SET line_items_synced = 1').run();

    const client2 = makeClient(() =>
      jsonResponse(page('invoices', [{ ...inv, total: 9999, last_modified_time: '2026-07-27T09:00:00+0530' }], false, 1))
    );
    await sync.syncEntity('invoices', { client: client2 });

    const row = getDb().prepare('SELECT * FROM invoices WHERE zoho_invoice_id = ?').get('I1');
    assert.equal(row.total, 9999);
    assert.equal(row.line_items_synced, 0);
  });

  test('a failing entity records last_status=error and keeps its old cursor', async () => {
    const client1 = makeClient(() =>
      jsonResponse(page('contacts', [contact(1, '2026-07-25T12:00:00+0530')], false, 1))
    );
    await sync.syncEntity('customers', { client: client1 });

    const client2 = makeClient(() => jsonResponse({ message: 'nope' }, { status: 400 }));
    await assert.rejects(() => sync.syncEntity('customers', { client: client2 }));

    const state = sync.getSyncState('customers');
    assert.equal(state.last_status, 'error');
    assert.match(state.last_error, /400/);
    assert.equal(state.cursor, '2026-07-25T12:00:00+0530');
  });
});

describe('sync: invoice line-item second pass', () => {
  function seedInvoices(n) {
    sync.upsertInvoices(Array.from({ length: n }, (_, i) => invoice(i + 1)));
  }

  function detailHandler({ path: p }) {
    const id = p.split('/').pop();
    return jsonResponse({
      invoice: {
        invoice_id: id,
        line_items: [
          { line_item_id: `${id}-L1`, item_id: 'ITM1', name: 'Frame', sku: 'FRM-1', quantity: 2, rate: 500, item_total: 1000 },
          { line_item_id: `${id}-L2`, item_id: 'ITM2', name: 'Tyre', sku: 'TYR-1', quantity: 1, rate: 250, item_total: 250 },
        ],
      },
    });
  }

  test('fetches details for pending invoices, stores lines and marks them synced', async () => {
    seedInvoices(3);
    const client = makeClient(detailHandler);

    const result = await sync.syncInvoiceLineItems({ client });

    assert.equal(result.processed, 3);
    assert.equal(result.pending, 0);
    assert.equal(count('invoice_line_items'), 6);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM invoices WHERE line_items_synced = 1').get().n, 3);
    // one detail call per invoice
    assert.equal(client.__fetch.calls.length, 3);
    assert.ok(client.__fetch.calls.every((c) => /\/books\/v3\/invoices\/I\d+$/.test(c.path)));
  });

  test('drains oldest-first and is resumable across batches', async () => {
    seedInvoices(5);
    const client = makeClient(detailHandler);

    const first = await sync.syncInvoiceLineItems({ client, limit: 2 });
    assert.equal(first.processed, 2);
    assert.equal(first.pending, 3);

    const doneIds = getDb()
      .prepare('SELECT zoho_invoice_id FROM invoices WHERE line_items_synced = 1 ORDER BY invoice_date')
      .all()
      .map((r) => r.zoho_invoice_id);
    const oldest = getDb()
      .prepare('SELECT zoho_invoice_id FROM invoices ORDER BY invoice_date ASC LIMIT 2')
      .all()
      .map((r) => r.zoho_invoice_id);
    assert.deepEqual(doneIds.sort(), oldest.sort(), 'oldest invoices are drained first');

    const second = await sync.syncInvoiceLineItems({ client, limit: 10 });
    assert.equal(second.processed, 3);
    assert.equal(second.pending, 0);
    assert.equal(sync.getSyncState('invoice_details').total_pending, 0);
  });

  test('re-running the pass is idempotent (no duplicate line items)', async () => {
    seedInvoices(2);
    const client = makeClient(detailHandler);
    await sync.syncInvoiceLineItems({ client });
    const afterFirst = count('invoice_line_items');

    getDb().prepare('UPDATE invoices SET line_items_synced = 0').run();
    await sync.syncInvoiceLineItems({ client });

    assert.equal(count('invoice_line_items'), afterFirst);
  });

  test('halts on the daily budget and leaves the rest pending', async () => {
    seedInvoices(5);
    const client = makeClient(detailHandler, { budget: 2 });

    const result = await sync.syncInvoiceLineItems({ client, limit: 10 });

    assert.equal(result.processed, 2);
    assert.equal(result.halted, true);
    assert.equal(result.pending, 3);
    const state = sync.getSyncState('invoice_details');
    assert.equal(state.last_status, 'halted');
    assert.match(state.last_error, /budget/i);
  });

  test('progress reporting matches the database', async () => {
    seedInvoices(4);
    const client = makeClient(detailHandler);
    await sync.syncInvoiceLineItems({ client, limit: 1 });
    const progress = sync.lineItemProgress();
    assert.deepEqual(progress, { total: 4, synced: 1, missing: 0, pending: 3 });
  });

  test('a 404 removes the invoice from the queue permanently instead of wedging it', async () => {
    seedInvoices(3);
    const ghost = getDb()
      .prepare('SELECT zoho_invoice_id FROM invoices ORDER BY invoice_date ASC LIMIT 1')
      .get().zoho_invoice_id;
    const client = makeClient(({ path: p }) => {
      const id = p.split('/').pop();
      if (id === ghost) {
        return jsonResponse(
          { code: 1002, message: "We couldn't find any resource for the given ID." },
          { status: 404 }
        );
      }
      return detailHandler({ path: p });
    });

    const result = await sync.syncInvoiceLineItems({ client });

    assert.equal(result.processed, 2, 'the other invoices still sync');
    assert.equal(result.failed, 0, 'a 404 is a skip, not a failure');
    assert.equal(result.pending, 0);
    assert.equal(result.missing, 1);
    assert.equal(
      getDb().prepare('SELECT line_items_synced FROM invoices WHERE zoho_invoice_id = ?').get(ghost)
        .line_items_synced,
      2
    );

    // re-running does not touch the missing invoice again
    const rerun = await sync.syncInvoiceLineItems({ client });
    assert.equal(rerun.processed, 0);
    assert.equal(rerun.missing, 1);

    // but if a list sync sees it again with a new last_modified_time, it re-queues
    const ghostIdx = Number(ghost.slice(1));
    sync.upsertInvoices([invoice(ghostIdx, { last_modified_time: '2026-08-01T09:00:00+0530' })]);
    assert.equal(sync.lineItemProgress().pending, 1);
  });
});

describe('sync: orchestration', () => {
  test('runSync walks every entity, fills line items and recomputes customer dates', async () => {
    const client = makeClient(({ path: p, query }) => {
      if (/\/invoices\/[^/]+$/.test(p) && !query.page) {
        const id = p.split('/').pop();
        return jsonResponse({ invoice: { invoice_id: id, line_items: [{ line_item_id: `${id}-L1`, name: 'Frame', quantity: 1, rate: 100, item_total: 100 }] } });
      }
      if (p.endsWith('/contacts')) return jsonResponse(page('contacts', [contact(1)], false, 1));
      if (p.endsWith('/invoices')) {
        return jsonResponse(
          page(
            'invoices',
            [
              invoice(1, { date: '2026-05-02', status: 'paid', balance: 0 }),
              invoice(2, { date: '2026-06-11' }),
              invoice(3, { date: '2026-07-01', status: 'void' }),
            ],
            false,
            1
          )
        );
      }
      if (p.endsWith('/customerpayments')) {
        return jsonResponse(
          page('customerpayments', [
            { payment_id: 'P1', payment_number: 'PMT-1', customer_id: 'C1', customer_name: 'Customer 1', date: '2026-06-01', amount: 500, payment_mode: 'cheque', invoices: [{ invoice_id: 'I1', amount_applied: 500 }], last_modified_time: '2026-07-20T10:00:00+0530' },
          ], false, 1)
        );
      }
      if (p.endsWith('/items')) return jsonResponse(page('items', [{ item_id: 'ITM1', name: 'Frame', sku: 'FRM-1', rate: 100, last_modified_time: '2026-07-20T10:00:00+0530' }], false, 1));
      if (p.endsWith('/salespersons')) return jsonResponse(page('salespersons', [{ salesperson_id: 'SP1', salesperson_name: 'Anil Mehta' }], false, 1));
      throw new Error(`unexpected path ${p}`);
    });

    const result = await sync.runSync({ client });

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(count('customers'), 1);
    assert.equal(count('invoices'), 3);
    assert.equal(count('payments'), 1);
    assert.equal(count('items'), 1);
    assert.equal(count('salespersons'), 1);
    assert.equal(result.lineItems.processed, 3);

    const customer = getDb().prepare('SELECT * FROM customers WHERE zoho_contact_id = ?').get('C1');
    // the void invoice (2026-07-01) must not count
    assert.equal(customer.first_invoice_date, '2026-05-02');
    assert.equal(customer.last_invoice_date, '2026-06-11');
    assert.equal(customer.invoice_count, 2);
  });

  test('a second run while one is in flight is skipped, not queued', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = makeClient(async ({ path: p }) => {
      if (p.endsWith('/salespersons')) {
        await gate;
        return jsonResponse(page('salespersons', [], false, 1));
      }
      return jsonResponse(page('contacts', [], false, 1));
    });

    const first = sync.runSync({ client, entities: ['salespersons'] });
    assert.equal(sync.isRunning(), true);
    const second = await sync.runSync({ client, entities: ['salespersons'] });
    assert.equal(second.skipped, true);

    release();
    await first;
    assert.equal(sync.isRunning(), false);
  });

  test('getSyncStatus reports cursors, row counts and line-item progress', async () => {
    sync.upsertInvoices([invoice(1), invoice(2)]);
    getDb().prepare('UPDATE invoices SET line_items_synced = 1 WHERE zoho_invoice_id = ?').run('I1');
    sync.updateSyncState('invoices', { cursor: '2026-07-25T12:00:00+0530', last_status: 'ok' });

    const status = sync.getSyncStatus();
    const invoices = status.entities.find((e) => e.entity === 'invoices');

    assert.equal(invoices.rowCount, 2);
    assert.equal(invoices.cursor, '2026-07-25T12:00:00+0530');
    assert.deepEqual(status.lineItems, { total: 2, synced: 1, missing: 0, pending: 1 });
    assert.equal(typeof status.apiCalls.budget, 'number');
  });
});
