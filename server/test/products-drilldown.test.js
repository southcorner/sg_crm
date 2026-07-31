'use strict';

/**
 * Product drill-down: model search + column sorting.
 *
 * The drill-down is capped by `limit`, so BOTH search and sort have to happen in
 * SQL — sorting the returned slice would just reorder whichever rows happened to
 * survive the cap. These tests pin that down, plus the LIKE escaping (an admin
 * searching for "50%" must not match everything) and the fact that the global
 * rep scope still applies while searching and sorting.
 *
 * Fixture — five models, one single-line invoice each, so a line's pro-rata
 * share is exactly the invoice total and every number below is obvious:
 *
 *   item  name                     sku       qty  revenue  customer / rep
 *   IT1   Battalion Ranger 27.5    BR-275      5     1000   C1 / SP1
 *   IT2   battalion cruiser        BC-100      2      400   C1 / SP1
 *   IT3   Velocity Sprint          VS-900      1      700   C1 / SP1
 *   IT4   50% Off Bundle           PROMO%X     9      200   C2 / SP2
 *   IT5   Model_A Frame            MDL_A       3      300   C2 / SP2
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcrm-drill-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DATA_DIR = TMP_DIR;
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const config = require('../src/config');
const attribution = require('../src/services/attribution');
const brands = require('../src/services/brands');
const perf = require('../src/services/performance');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const TABLES = [
  'item_brand_map',
  'brand_rules',
  'brands',
  'customer_rep_assignments',
  'invoice_line_items',
  'payments',
  'invoices',
  'items',
  'customers',
  'salespersons',
];

const MONTH = '2026-05';

function resetDb() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('brands','brand_rules')");
  db.exec('PRAGMA foreign_keys = ON');
  config.setSetting(attribution.VISIBLE_REPS_SETTING, null);
  config.setSetting(attribution.SHOW_UNATTRIBUTED_SETTING, true);
}

const MODELS = [
  // id,   name,                    sku,        category, qty, revenue, customer, rep
  ['IT1', 'Battalion Ranger 27.5', 'BR-275', 'MTB', 5, 1000, 'C1', 'SP1'],
  ['IT2', 'battalion cruiser', 'BC-100', 'City', 2, 400, 'C1', 'SP1'],
  ['IT3', 'Velocity Sprint', 'VS-900', 'Road', 1, 700, 'C1', 'SP1'],
  ['IT4', '50% Off Bundle', 'PROMO%X', 'Promo', 9, 200, 'C2', 'SP2'],
  ['IT5', 'Model_A Frame', 'MDL_A', 'Frames', 3, 300, 'C2', 'SP2'],
];

function seedWorld() {
  const db = getDb();

  for (const [id, name] of [['SP1', 'Anil Mehta'], ['SP2', 'Priya Nair']]) {
    db.prepare("INSERT INTO salespersons (zoho_salesperson_id, name, is_active) VALUES (?, ?, 1)").run(id, name);
  }
  for (const [id, name] of [['C1', 'Alpha Cycles'], ['C2', 'Beta Bikes']]) {
    db.prepare("INSERT INTO customers (zoho_contact_id, contact_name, status) VALUES (?, ?, 'active')").run(id, name);
  }

  for (const [id, name, sku, category] of MODELS) {
    db.prepare('INSERT INTO items (zoho_item_id, name, sku, category_name) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      sku,
      category
    );
  }

  // two brands by category; the promo and the frame stay unmapped
  const b1 = Number(db.prepare("INSERT INTO brands (name, sort_order) VALUES ('Battalion', 1)").run().lastInsertRowid);
  const b2 = Number(db.prepare("INSERT INTO brands (name, sort_order) VALUES ('Velocity', 2)").run().lastInsertRowid);
  const rule = db.prepare(
    'INSERT INTO brand_rules (brand_id, rule_type, match_value, priority) VALUES (?, ?, ?, ?)'
  );
  rule.run(b1, 'category', 'MTB', 10);
  rule.run(b1, 'category', 'City', 20);
  rule.run(b2, 'category', 'Road', 30);
  brands.remapItems();

  MODELS.forEach(([itemId, name, sku, , qty, revenue, customer, rep], idx) => {
    const invId = `INV${idx + 1}`;
    db.prepare(
      `INSERT INTO invoices (zoho_invoice_id, invoice_number, customer_id, customer_name, salesperson_id,
         salesperson_name, invoice_date, due_date, status, total, sub_total, balance, line_items_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, 0, 1)`
    ).run(invId, invId, customer, customer, rep, rep, `${MONTH}-1${idx}`, `${MONTH}-2${idx}`, revenue, revenue);
    db.prepare(
      `INSERT INTO invoice_line_items (zoho_line_item_id, invoice_id, item_id, line_order, name, sku, quantity, rate, item_total)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`
    ).run(`${invId}-L1`, invId, itemId, name, sku, qty, revenue / qty, revenue);
  });

  return { b1, b2 };
}

const ids = (out) => out.rows.map((r) => r.item_id);
const run = (opts) => perf.products({ month: MONTH, ...opts });

before(() => {
  runMigrations();
  config.seedSettingDefaults();
});

after(() => {
  closeDb();
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* windows may still hold the wal file */
  }
});

beforeEach(() => {
  resetDb();
  seedWorld();
});

// ===========================================================================
// baseline
// ===========================================================================

describe('drill-down: unchanged defaults', () => {
  test('with no search or sort the order is still revenue DESC', () => {
    const out = run({});
    assert.deepEqual(ids(out), ['IT1', 'IT3', 'IT2', 'IT5', 'IT4']);
    assert.equal(out.filters.search, null);
    assert.equal(out.filters.sort, null);
    assert.equal(out.matched, 5);
    assert.equal(out.truncated, false);
  });

  test('revenue is still the pro-rata share and the totals still foot', () => {
    const out = run({});
    assert.equal(out.rows.find((r) => r.item_id === 'IT1').revenue, 1000);
    assert.equal(out.totals.revenue, 2600);
    assert.equal(out.totals.quantity, 20);
  });
});

// ===========================================================================
// one row per model
// ===========================================================================

describe('drill-down: a model is one row, keyed by item_id', () => {
  /**
   * Regression, found on the live org. Zoho snapshots the item name onto every
   * line, so an item that was RENAMED has lines carrying both the old and the
   * new name. The drill-down grouped by `item_name`, and because the line_brand
   * CTE exposes a real column of that name, SQLite bound the GROUP BY term to
   * the raw line name rather than to the COALESCE alias — splitting one model
   * into two rows that looked identical (both display items.name) and then
   * collided on the client's React key, leaving orphan rows in the table
   * whenever the sort changed. Grouping on an unambiguous alias fixes it.
   */
  function addSecondLine(itemId, storedName, qty, amount) {
    const db = getDb();
    const invId = `INV-DUP-${itemId}`;
    db.prepare(
      `INSERT INTO invoices (zoho_invoice_id, invoice_number, customer_id, customer_name, salesperson_id,
         salesperson_name, invoice_date, due_date, status, total, sub_total, balance, line_items_synced)
       VALUES (?, ?, 'C1', 'C1', 'SP1', 'SP1', ?, ?, 'sent', ?, ?, 0, 1)`
    ).run(invId, invId, `${MONTH}-28`, `${MONTH}-28`, amount, amount);
    db.prepare(
      `INSERT INTO invoice_line_items (zoho_line_item_id, invoice_id, item_id, line_order, name, sku, quantity, rate, item_total)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`
    ).run(`${invId}-L1`, invId, itemId, storedName, 'BR-275', qty, amount / qty, amount);
  }

  test('a renamed item stays ONE row, not one per historical name', () => {
    // the item is still 'Battalion Ranger 27.5' in `items`; this older line
    // remembers what it used to be called
    addSecondLine('IT1', 'Battalion Ranger 27.5 OLD NAME', 1, 100);

    const out = run({});
    const it1 = out.rows.filter((r) => r.item_id === 'IT1');
    assert.equal(it1.length, 1, 'one model, one row');
    assert.equal(it1[0].quantity, 6, '5 + 1');
    assert.equal(it1[0].revenue, 1100, '1000 + 100');
    assert.equal(it1[0].invoice_count, 2);
    assert.equal(it1[0].item_name, 'Battalion Ranger 27.5', 'the current name from `items` wins');
  });

  test('every row carries a unique group_key — the client keys rows on it', () => {
    addSecondLine('IT1', 'Battalion Ranger 27.5 OLD NAME', 1, 100);

    for (const opts of [{}, { sort: 'name', dir: 'asc' }, { sort: 'name', dir: 'desc' }, { sort: 'revenue', dir: 'asc' }]) {
      const out = run(opts);
      const keys = out.rows.map((r) => `${r.group_key}-${r.brand_id ?? 'none'}`);
      assert.equal(new Set(keys).size, keys.length, `duplicate group_key with ${JSON.stringify(opts)}`);
      assert.equal(keys.every((k) => k), true, 'every row has a group_key');
    }
  });

  test('matched agrees with the row count once the split is healed', () => {
    addSecondLine('IT1', 'Battalion Ranger 27.5 OLD NAME', 1, 100);
    const out = run({});
    assert.equal(out.matched, 5, 'still five models, not six');
    assert.equal(out.rows.length, 5);
  });

  test('ad-hoc lines with no item_id still group by their own name', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO invoices (zoho_invoice_id, invoice_number, customer_id, customer_name, salesperson_id,
         salesperson_name, invoice_date, due_date, status, total, sub_total, balance, line_items_synced)
       VALUES ('INV-ADHOC', 'INV-ADHOC', 'C1', 'C1', 'SP1', 'SP1', ?, ?, 'sent', 90, 90, 0, 1)`
    ).run(`${MONTH}-27`, `${MONTH}-27`);
    db.prepare(
      `INSERT INTO invoice_line_items (zoho_line_item_id, invoice_id, item_id, line_order, name, quantity, rate, item_total)
       VALUES ('INV-ADHOC-L1', 'INV-ADHOC', NULL, 0, 'Freight charge', 1, 60, 60),
              ('INV-ADHOC-L2', 'INV-ADHOC', NULL, 1, 'Gift wrap', 1, 30, 30)`
    ).run();

    const out = run({});
    const adhoc = out.rows.filter((r) => !r.item_id);
    assert.deepEqual(adhoc.map((r) => r.item_name).sort(), ['Freight charge', 'Gift wrap'], 'two distinct ad-hoc lines');
    assert.equal(new Set(out.rows.map((r) => r.group_key)).size, out.rows.length);
  });
});

// ===========================================================================
// search
// ===========================================================================

describe('drill-down: model search', () => {
  test('matches the model name, case-insensitively', () => {
    const out = run({ search: 'battalion' });
    assert.deepEqual(ids(out).sort(), ['IT1', 'IT2'], 'both cases of "battalion"');
    assert.equal(out.filters.search, 'battalion');
    assert.equal(out.matched, 2);

    assert.deepEqual(ids(run({ search: 'BATTALION' })).sort(), ['IT1', 'IT2']);
    assert.deepEqual(ids(run({ search: 'BaTtAlIoN' })).sort(), ['IT1', 'IT2']);
  });

  test('matches the SKU independently of the name', () => {
    // "br" appears in no model NAME — only in the SKU BR-275
    assert.deepEqual(ids(run({ search: 'br' })), ['IT1']);
    assert.deepEqual(ids(run({ search: 'vs-900' })), ['IT3'], 'sku match is case-insensitive too');
    assert.deepEqual(ids(run({ search: 'BC-100' })), ['IT2']);
  });

  test('matches a substring anywhere, not just a prefix', () => {
    assert.deepEqual(ids(run({ search: 'ranger' })), ['IT1']);
    assert.deepEqual(ids(run({ search: '27.5' })), ['IT1']);
    assert.deepEqual(ids(run({ search: 'sprint' })), ['IT3']);
  });

  test('% is escaped — searching for it finds the literal, not everything', () => {
    const out = run({ search: '%' });
    assert.deepEqual(ids(out), ['IT4'], 'only "50% Off Bundle" / "PROMO%X" contain a literal %');
    assert.equal(out.matched, 1, 'an unescaped % would have matched all five');

    assert.deepEqual(ids(run({ search: '50%' })), ['IT4']);
    assert.deepEqual(ids(run({ search: 'PROMO%X' })), ['IT4']);
  });

  test('_ is escaped — it is a literal underscore, not "any character"', () => {
    const out = run({ search: '_' });
    assert.deepEqual(ids(out), ['IT5'], 'only "Model_A" / "MDL_A" contain a literal _');
    assert.equal(out.matched, 1, 'an unescaped _ would have matched all five');

    assert.deepEqual(ids(run({ search: 'model_a' })), ['IT5']);
    assert.deepEqual(ids(run({ search: 'MDL_A' })), ['IT5']);
  });

  test('a backslash is escaped too, so it cannot break the ESCAPE clause', () => {
    // a trailing backslash used to swallow the closing % of the pattern
    assert.doesNotThrow(() => run({ search: '\\' }));
    assert.deepEqual(ids(run({ search: '\\' })), [], 'no model has a backslash');
    assert.doesNotThrow(() => run({ search: '100%\\' }));
  });

  test('no match is an empty list, not an error', () => {
    const out = run({ search: 'zzz-nothing' });
    assert.deepEqual(out.rows, []);
    assert.equal(out.matched, 0);
    assert.equal(out.totals.revenue, 0);
  });

  test('blank and whitespace-only searches behave like no search', () => {
    assert.equal(run({ search: '' }).rows.length, 5);
    assert.equal(run({ search: '   ' }).rows.length, 5);
    assert.equal(run({ search: '   ' }).filters.search, null);
  });

  test('the search is trimmed', () => {
    assert.deepEqual(ids(run({ search: '  sprint  ' })), ['IT3']);
    assert.equal(run({ search: '  sprint  ' }).filters.search, 'sprint');
  });

  test('search composes with the brand filter', () => {
    const { b1 } = { b1: getDb().prepare("SELECT id FROM brands WHERE name = 'Battalion'").get().id };
    assert.deepEqual(ids(run({ search: 'battalion', brand: b1 })).sort(), ['IT1', 'IT2']);
    assert.deepEqual(ids(run({ search: 'sprint', brand: b1 })), [], 'Velocity model, Battalion filter');
  });

  test('the totals and the pending-invoice count follow the search', () => {
    const out = run({ search: 'battalion' });
    assert.equal(out.totals.revenue, 1400, '1000 + 400');
    assert.equal(out.totals.items, 2);
    assert.equal(out.pendingInvoices, 0, 'the pending count is about invoices, not the search');
  });
});

// ===========================================================================
// sorting
// ===========================================================================

describe('drill-down: column sorting', () => {
  test('revenue ascending and descending', () => {
    assert.deepEqual(ids(run({ sort: 'revenue', dir: 'asc' })), ['IT4', 'IT5', 'IT2', 'IT3', 'IT1']);
    assert.deepEqual(ids(run({ sort: 'revenue', dir: 'desc' })), ['IT1', 'IT3', 'IT2', 'IT5', 'IT4']);
  });

  test('name sorts case-insensitively, both ways', () => {
    // 50% … < battalion cruiser < Battalion Ranger < Model_A < Velocity
    assert.deepEqual(ids(run({ sort: 'name', dir: 'asc' })), ['IT4', 'IT2', 'IT1', 'IT5', 'IT3']);
    assert.deepEqual(ids(run({ sort: 'name', dir: 'desc' })), ['IT3', 'IT5', 'IT1', 'IT2', 'IT4']);
  });

  test('quantity, sku, brand and the count columns all sort', () => {
    assert.deepEqual(ids(run({ sort: 'quantity', dir: 'desc' })), ['IT4', 'IT1', 'IT5', 'IT2', 'IT3']);
    assert.deepEqual(ids(run({ sort: 'quantity', dir: 'asc' })), ['IT3', 'IT2', 'IT5', 'IT1', 'IT4']);

    // BC-100 < BR-275 < MDL_A < PROMO%X < VS-900
    assert.deepEqual(ids(run({ sort: 'sku', dir: 'asc' })), ['IT2', 'IT1', 'IT5', 'IT4', 'IT3']);

    // Battalion (IT1, IT2) then Velocity (IT3), then the unmapped pair last
    const byBrand = run({ sort: 'brand', dir: 'asc' });
    assert.deepEqual(byBrand.rows.slice(0, 3).map((r) => r.brand_name), ['Battalion', 'Battalion', 'Velocity']);
    assert.deepEqual(
      byBrand.rows.slice(3).map((r) => r.brand_name),
      ['Unmapped', 'Unmapped'],
      'NULL brands sort last'
    );

    assert.equal(run({ sort: 'invoices', dir: 'desc' }).rows.length, 5);
    assert.equal(run({ sort: 'customers', dir: 'desc' }).rows.length, 5);
    assert.equal(run({ sort: 'category', dir: 'asc' }).rows[0].category_name, 'City');
  });

  test('dir defaults to desc and is case-insensitive', () => {
    assert.deepEqual(ids(run({ sort: 'revenue' })), ids(run({ sort: 'revenue', dir: 'desc' })));
    assert.deepEqual(ids(run({ sort: 'revenue', dir: 'ASC' })), ids(run({ sort: 'revenue', dir: 'asc' })));
  });

  test('an unknown sort column is ignored by the service and falls back to the default', () => {
    const out = run({ sort: 'revenue; DROP TABLE items', dir: 'asc' });
    assert.deepEqual(ids(out), ['IT1', 'IT3', 'IT2', 'IT5', 'IT4'], 'default revenue DESC');
    assert.equal(out.filters.sort, null);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM items').get().n, 5, 'items table intact');
  });

  test('the sort is echoed back so the UI can render its caret', () => {
    const out = run({ sort: 'quantity', dir: 'asc' });
    assert.equal(out.filters.sort, 'quantity');
    assert.equal(out.filters.dir, 'asc');
  });

  test('sorting happens in SQL, so the cap keeps the right rows', () => {
    // top 2 by revenue vs bottom 2 — a client-side sort of a capped list could
    // never produce the second answer
    assert.deepEqual(ids(run({ sort: 'revenue', dir: 'desc', limit: 2 })), ['IT1', 'IT3']);
    assert.deepEqual(ids(run({ sort: 'revenue', dir: 'asc', limit: 2 })), ['IT4', 'IT5']);
  });

  test('search and sort compose', () => {
    assert.deepEqual(ids(run({ search: 'battalion', sort: 'revenue', dir: 'asc' })), ['IT2', 'IT1']);
    assert.deepEqual(ids(run({ search: 'battalion', sort: 'name', dir: 'asc' })), ['IT2', 'IT1']);
  });
});

// ===========================================================================
// the cap
// ===========================================================================

describe('drill-down: "showing top N" reflects the search', () => {
  test('matched counts every match, rows is the capped slice', () => {
    const out = run({ limit: 2 });
    assert.equal(out.rows.length, 2);
    assert.equal(out.matched, 5);
    assert.equal(out.limit, 2);
    assert.equal(out.truncated, true);
  });

  test('once a search narrows it below the cap, nothing is truncated', () => {
    const out = run({ limit: 2, search: 'sprint' });
    assert.equal(out.rows.length, 1);
    assert.equal(out.matched, 1);
    assert.equal(out.truncated, false);
  });

  test('matched respects the search, not just the window', () => {
    assert.equal(run({ limit: 1, search: 'battalion' }).matched, 2);
    assert.equal(run({ limit: 1 }).matched, 5);
  });
});

// ===========================================================================
// rep scope must survive both
// ===========================================================================

describe('drill-down: the rep scope is not regressed', () => {
  test('searching still only sees in-scope models', () => {
    // SP1 owns IT1/IT2/IT3 (customer C1); SP2 owns IT4/IT5 (customer C2)
    assert.equal(run({}).rows.length, 5);

    config.setSetting(attribution.VISIBLE_REPS_SETTING, ['SP1']);
    assert.deepEqual(ids(run({})).sort(), ['IT1', 'IT2', 'IT3']);

    // the promo model belongs to the hidden rep — a search must not surface it
    assert.deepEqual(ids(run({ search: '%' })), [], 'IT4 is out of scope');
    assert.deepEqual(ids(run({ search: '_' })), [], 'IT5 is out of scope');
    assert.deepEqual(ids(run({ search: 'battalion' })).sort(), ['IT1', 'IT2']);
  });

  test('sorting still only sees in-scope models, and matched agrees', () => {
    config.setSetting(attribution.VISIBLE_REPS_SETTING, ['SP1']);

    const out = run({ sort: 'revenue', dir: 'asc' });
    assert.deepEqual(ids(out), ['IT2', 'IT3', 'IT1'], 'the hidden rep`s 200 and 300 are absent');
    assert.equal(out.matched, 3);
    assert.equal(out.totals.revenue, 2100, '1000 + 400 + 700');
  });

  test('hiding unattributed data also survives search and sort', () => {
    // strip the salesperson off IT4/IT5's invoices so they are unattributed
    getDb().prepare("UPDATE invoices SET salesperson_id = NULL, salesperson_name = NULL WHERE zoho_invoice_id IN ('INV4','INV5')").run();
    assert.deepEqual(ids(run({ search: '%' })), ['IT4'], 'unattributed is visible by default');

    config.setSetting(attribution.SHOW_UNATTRIBUTED_SETTING, false);
    assert.deepEqual(ids(run({ search: '%' })), [], 'now hidden');
    assert.deepEqual(ids(run({ sort: 'revenue', dir: 'asc' })), ['IT2', 'IT3', 'IT1']);
  });
});

// ===========================================================================
// HTTP
// ===========================================================================

describe('drill-down: GET /api/performance/products', () => {
  let server;
  let origin;
  let cookie = null;

  before(async () => {
    require('../src/services/adminUser').ensureAdminUser();
    const { createApp } = require('../src/index');
    const app = createApp(getDb());
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await call('/api/auth/login', { username: 'admin', password: 'admin123' })).status, 200);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function call(pathname, body) {
    const res = await fetch(origin + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  const products = (qs) => call(`/api/performance/products?month=${MONTH}${qs ? `&${qs}` : ''}`);

  test('search and sort come through the query string', async () => {
    const searched = await products('search=battalion');
    assert.equal(searched.status, 200);
    assert.deepEqual(searched.json.rows.map((r) => r.item_id).sort(), ['IT1', 'IT2']);

    const sorted = await products('sort=name&dir=asc');
    assert.deepEqual(sorted.json.rows.map((r) => r.item_id), ['IT4', 'IT2', 'IT1', 'IT5', 'IT3']);
  });

  test('an unknown sort column is a 400 that lists the valid ones', async () => {
    const res = await products('sort=item_total');
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid request');
    assert.match(JSON.stringify(res.json.details), /sort must be one of/);
    assert.match(JSON.stringify(res.json.details), /revenue/);
  });

  test('an injection attempt in sort is a 400, not a query', async () => {
    const res = await products(`sort=${encodeURIComponent('revenue DESC; DROP TABLE items')}`);
    assert.equal(res.status, 400);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM items').get().n, 5);
  });

  test('a bad dir is a 400', async () => {
    const res = await products('sort=revenue&dir=sideways');
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.json.details), /dir must be asc or desc/);
  });

  test('DIR is accepted in either case', async () => {
    const upper = await products('sort=revenue&dir=ASC');
    assert.equal(upper.status, 200);
    assert.deepEqual(upper.json.rows.map((r) => r.item_id), ['IT4', 'IT5', 'IT2', 'IT3', 'IT1']);
  });

  test('an over-long search is rejected rather than hammering the db', async () => {
    const res = await products(`search=${'x'.repeat(200)}`);
    assert.equal(res.status, 400);
  });

  test('the response carries what the UI needs to render its state', async () => {
    const res = await products('search=battalion&sort=quantity&dir=asc&limit=1');
    assert.equal(res.json.filters.search, 'battalion');
    assert.equal(res.json.filters.sort, 'quantity');
    assert.equal(res.json.filters.dir, 'asc');
    assert.equal(res.json.matched, 2);
    assert.equal(res.json.limit, 1);
    assert.equal(res.json.truncated, true);
  });
});
