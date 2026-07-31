'use strict';

/**
 * Global rep visibility scope.
 *
 * The org runs online and offline sales teams out of one Zoho org; the admin
 * picks which reps this CRM is about. Everything below asserts the same rule
 * from a different angle:
 *
 *     visible  ⇔  effective rep ∈ visible set  OR  no effective rep at all
 *
 * Unattributed data is ALWAYS visible — on the real org that is ~7,400 invoices,
 * and hiding them would quietly delete a third of the business from every
 * screen. `visible_rep_ids = null` (the default) means "everything".
 *
 * Fixture, used by nearly every test here:
 *   SP1 Anil    → customer C1 (Alpha)
 *   SP2 Priya   → customer C2 (Beta)      ← hidden once the scope is [SP1]
 *   (no rep)    → customer C3 (Gamma)     ← unattributed, always visible
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcrm-scope-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DATA_DIR = TMP_DIR;
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const config = require('../src/config');
const attribution = require('../src/services/attribution');
const performance = require('../src/services/performance');
const dormant = require('../src/services/dormant');
const cheques = require('../src/services/cheques');
const focus = require('../src/services/focus');
const engine = require('../src/services/reminders/engine');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const TABLES = [
  'reminders_log',
  'cheques',
  'focus_plans',
  'targets',
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

function resetDb() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('cheques','focus_plans','targets','brands','brand_rules')");
  db.exec('PRAGMA foreign_keys = ON');
  setScope(null);
  setShowUnattributed(true);
}

/** Write the setting the way the settings route does. */
function setScope(ids) {
  config.setSetting(attribution.VISIBLE_REPS_SETTING, ids);
}

/** show_unattributed — the second, independent axis of the scope. */
function setShowUnattributed(on) {
  config.setSetting(attribution.SHOW_UNATTRIBUTED_SETTING, on);
}

function addRep(id, name, extra = {}) {
  getDb()
    .prepare(
      'INSERT INTO salespersons (zoho_salesperson_id, name, email, crm_email, notify_email, is_active) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, name, extra.email || `${id.toLowerCase()}@example.in`, extra.crm_email || null, 1, extra.is_active ?? 1);
  return id;
}

function addCustomer(id, name, outstanding = 0) {
  getDb()
    .prepare(
      "INSERT INTO customers (zoho_contact_id, contact_name, status, outstanding_receivable) VALUES (?, ?, 'active', ?)"
    )
    .run(id, name, outstanding);
  return id;
}

function addInvoice(id, { customer, rep = null, repName = null, date, due = null, total, balance = 0, status = 'sent', lines = [] }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO invoices (zoho_invoice_id, invoice_number, customer_id, customer_name, salesperson_id,
       salesperson_name, invoice_date, due_date, status, total, sub_total, balance, line_items_synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, id, customer, customer, rep, repName, date, due || date, status, total, total, balance, lines.length ? 1 : 0);
  lines.forEach((li, idx) => {
    db.prepare(
      `INSERT INTO invoice_line_items (zoho_line_item_id, invoice_id, item_id, line_order, name, quantity, rate, item_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(`${id}-L${idx + 1}`, id, li.item_id, idx, li.name || '', li.quantity ?? 1, li.rate ?? 0, li.item_total);
  });
  return id;
}

function addPayment(id, customer, amount, date) {
  getDb()
    .prepare(
      'INSERT INTO payments (zoho_payment_id, payment_number, customer_id, customer_name, payment_date, amount, payment_mode) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, id, customer, customer, date, amount, 'cash');
  return id;
}

/** The shared three-rep / three-customer world described at the top. */
function seedWorld() {
  addRep('SP1', 'Anil Mehta');
  addRep('SP2', 'Priya Nair');
  addRep('SP3', 'Rahul Desai');
  addCustomer('C1', 'Alpha Cycles', 1000);
  addCustomer('C2', 'Beta Bikes', 2000);
  addCustomer('C3', 'Gamma Gear', 500);

  const db = getDb();
  db.prepare("INSERT INTO items (zoho_item_id, name, sku, category_name) VALUES ('IT1', 'Widget', 'W-1', 'Widgets')").run();
  const brand = db.prepare("INSERT INTO brands (name, sort_order) VALUES ('Acme', 1)").run();
  const brandId = Number(brand.lastInsertRowid);
  db.prepare(
    "INSERT INTO brand_rules (brand_id, rule_type, match_value, priority) VALUES (?, 'category', 'Widgets', 10)"
  ).run(brandId);
  require('../src/services/brands').remapItems();

  addInvoice('I1', {
    customer: 'C1', rep: 'SP1', repName: 'Anil Mehta',
    date: '2026-05-04', due: '2026-05-01', total: 1000, balance: 1000,
    lines: [{ item_id: 'IT1', name: 'Widget', item_total: 1000, quantity: 1 }],
  });
  addInvoice('I2', {
    customer: 'C2', rep: 'SP2', repName: 'Priya Nair',
    date: '2026-05-05', due: '2026-05-01', total: 2000, balance: 2000,
    lines: [{ item_id: 'IT1', name: 'Widget', item_total: 2000, quantity: 2 }],
  });
  // no salesperson at all — the ~7,400-invoice case
  addInvoice('I3', {
    customer: 'C3', rep: null, repName: null,
    date: '2026-05-06', due: '2026-05-01', total: 500, balance: 500,
    lines: [{ item_id: 'IT1', name: 'Widget', item_total: 500, quantity: 1 }],
  });

  addPayment('P1', 'C1', 100, '2026-05-10');
  addPayment('P2', 'C2', 200, '2026-05-10');
  addPayment('P3', 'C3', 300, '2026-05-10');

  return { brandId };
}

const ONLY_SP1 = ['SP1'];

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
});

// ===========================================================================
// the helper itself
// ===========================================================================

describe('repScopeFilter: the one helper everything reuses', () => {
  beforeEach(() => seedWorld());

  test('an absent setting means every rep is visible and the filter is a no-op', () => {
    assert.equal(attribution.visibleRepIds(), null);
    assert.equal(attribution.repScopeActive(), false);

    const scope = attribution.invoiceScopeFilter('i');
    assert.equal(scope.active, false);
    assert.equal(scope.sql, '1 = 1');
    assert.deepEqual(scope.params, {});
  });

  test('a set scope produces bound parameters — ids are never inlined into SQL', () => {
    setScope(ONLY_SP1);
    const scope = attribution.invoiceScopeFilter('i');

    assert.equal(scope.active, true);
    assert.match(scope.sql, /^IFNULL\(/);
    assert.equal(Object.values(scope.params).includes('SP1'), true);
    assert.equal(/'SP1'/.test(scope.sql), false, 'the id must be a parameter, not a literal');
  });

  test('two filters can coexist in one statement via distinct prefixes', () => {
    setScope(ONLY_SP1);
    const a = attribution.invoiceScopeFilter('i', { prefix: 'sa' });
    const b = attribution.customerScopeFilter('c', { prefix: 'sb' });
    assert.deepEqual(Object.keys(a.params).sort(), ['sa_0', 'sa_none']);
    assert.deepEqual(Object.keys(b.params).sort(), ['sb_0', 'sb_none']);
  });

  test('garbage in the setting fails open rather than hiding the whole CRM', () => {
    config.setSetting(attribution.VISIBLE_REPS_SETTING, 'not-an-array');
    assert.equal(attribution.visibleRepIds(), null);
    assert.equal(attribution.repScopeActive(), false);
  });

  test('ids that could not be a Zoho id are dropped from the set', () => {
    config.setSetting(attribution.VISIBLE_REPS_SETTING, ['SP1', "x'; DROP TABLE customers; --"]);
    assert.deepEqual(attribution.visibleRepIds(), ['SP1']);
  });

  test('isRepVisible: unattributed passes, in-scope passes, out-of-scope does not', () => {
    setScope(ONLY_SP1);
    assert.equal(attribution.isRepVisible('SP1'), true);
    assert.equal(attribution.isRepVisible('SP2'), false);
    assert.equal(attribution.isRepVisible(null), true, 'no rep is always visible');
    assert.equal(attribution.isRepVisible(''), true);
  });

  test('isCustomerVisible / isInvoiceVisible follow the same rule', () => {
    setScope(ONLY_SP1);
    assert.equal(attribution.isCustomerVisible('C1'), true);
    assert.equal(attribution.isCustomerVisible('C2'), false);
    assert.equal(attribution.isCustomerVisible('C3'), true, 'unattributed customer stays visible');
    assert.equal(attribution.isCustomerVisible('NOPE'), false);

    assert.equal(attribution.isInvoiceVisible('I1'), true);
    assert.equal(attribution.isInvoiceVisible('I2'), false);
    assert.equal(attribution.isInvoiceVisible('I3'), true);
  });

  test('an empty set hides every rep but still shows unattributed data', () => {
    setScope([]);
    assert.equal(attribution.repScopeActive(), true);
    assert.equal(attribution.isCustomerVisible('C1'), false);
    assert.equal(attribution.isCustomerVisible('C2'), false);
    assert.equal(attribution.isCustomerVisible('C3'), true);
  });

  test('an invoice whose salesperson matches no salespersons row is unattributed, so visible', () => {
    addInvoice('I9', {
      customer: 'C3', rep: 'SP-GONE', repName: 'Someone Who Left',
      date: '2026-05-07', total: 90, balance: 90,
    });
    setScope(ONLY_SP1);
    assert.equal(attribution.isInvoiceVisible('I9'), true);
  });

  test('an invoice with an unknown id but a matching NAME resolves to that rep, and is scoped', () => {
    addInvoice('I8', {
      customer: 'C3', rep: 'SP-UNKNOWN', repName: 'Priya Nair',
      date: '2026-05-07', total: 70, balance: 70,
    });
    setScope(ONLY_SP1);
    assert.equal(attribution.isInvoiceVisible('I8'), false, 'name-matched to the hidden SP2');
  });

  test('reassigning a customer moves its invoices across the scope boundary', () => {
    setScope(ONLY_SP1);
    assert.equal(attribution.isInvoiceVisible('I2'), false);

    // hand Beta Bikes to the visible rep — its whole history comes into scope
    attribution.assignCustomer('C2', 'SP1', 'all_history', null, { now: new Date('2026-06-01T10:00:00') });
    assert.equal(attribution.isInvoiceVisible('I2'), true);
    assert.equal(attribution.isCustomerVisible('C2'), true);
  });

  test('repScopeSummary drives the "showing X of Y reps" indicator', () => {
    assert.deepEqual(attribution.repScopeSummary(), {
      active: false, visible: 3, total: 3, hidden: 0, visibleRepIds: null, showUnattributed: true,
    });
    setScope(ONLY_SP1);
    assert.deepEqual(attribution.repScopeSummary(), {
      active: true, visible: 1, total: 3, hidden: 2, visibleRepIds: ['SP1'], showUnattributed: true,
    });
  });

  test('listReps always sees everyone; visibleOnly is opt-in for dropdowns', () => {
    setScope(ONLY_SP1);
    const all = attribution.listReps();
    assert.equal(all.length, 3, 'the Reps page must never hide the reps you manage');
    assert.deepEqual(all.filter((r) => r.visible).map((r) => r.id), ['SP1']);
    assert.deepEqual(attribution.listReps({ visibleOnly: true }).map((r) => r.id), ['SP1']);
  });
});

// ===========================================================================
// hiding unattributed data — the second, independent axis
// ===========================================================================

describe('show_unattributed', () => {
  beforeEach(() => seedWorld());

  test('defaults to true, so nothing changes for an existing install', () => {
    assert.equal(attribution.showUnattributed(), true);
    assert.equal(attribution.repScopeActive(), false);
    assert.equal(attribution.invoiceScopeFilter('i').active, false);
  });

  test('EDGE CASE: all reps visible + unattributed hidden is an ACTIVE filter', () => {
    setScope(null); // every rep
    setShowUnattributed(false);

    assert.equal(attribution.repScopeActive(), true, 'no rep is hidden, but the filter is still on');

    const scope = attribution.invoiceScopeFilter('i');
    assert.equal(scope.active, true);
    assert.match(scope.sql, /IS NOT NULL$/, 'with no id list to match, the rule is simply "has a rep"');
    assert.deepEqual(scope.params, {}, 'nothing to bind in this state');

    // every rep-attributed row survives; only the unattributed one goes
    assert.equal(attribution.isInvoiceVisible('I1'), true, 'SP1');
    assert.equal(attribution.isInvoiceVisible('I2'), true, 'SP2 — still visible, no rep is hidden');
    assert.equal(attribution.isInvoiceVisible('I3'), false, 'no salesperson');
    assert.equal(attribution.isCustomerVisible('C1'), true);
    assert.equal(attribution.isCustomerVisible('C2'), true);
    assert.equal(attribution.isCustomerVisible('C3'), false);
  });

  test('combined with a rep subset, only that rep survives', () => {
    setScope(ONLY_SP1);
    setShowUnattributed(false);

    const scope = attribution.invoiceScopeFilter('i');
    assert.equal(scope.active, true);
    assert.equal(
      scope.sql.includes('@repscope_none,'),
      false,
      'the sentinel is bound for the IFNULL but must NOT be in the IN list'
    );
    assert.ok('repscope_none' in scope.params, 'IFNULL references it, so it must still be bound');

    assert.equal(attribution.isInvoiceVisible('I1'), true);
    assert.equal(attribution.isInvoiceVisible('I2'), false);
    assert.equal(attribution.isInvoiceVisible('I3'), false);
  });

  test('no reps and no unattributed hides absolutely everything', () => {
    setScope([]);
    setShowUnattributed(false);
    const scope = attribution.invoiceScopeFilter('i');
    assert.equal(scope.sql, '0 = 1');
    assert.deepEqual(scope.params, {});
    assert.equal(attribution.isInvoiceVisible('I1'), false);
    assert.equal(attribution.isInvoiceVisible('I3'), false);
  });

  test('isRepVisible(null) follows the setting', () => {
    assert.equal(attribution.isRepVisible(null), true);
    setShowUnattributed(false);
    assert.equal(attribution.isRepVisible(null), false);
    assert.equal(attribution.isRepVisible('SP2'), true, 'reps themselves are untouched');
  });

  test('a malformed value fails open rather than hiding a third of the org', () => {
    config.setSetting(attribution.SHOW_UNATTRIBUTED_SETTING, 'maybe');
    assert.equal(attribution.showUnattributed(), true);
    assert.equal(attribution.repScopeActive(), false);
  });

  test('repScopeSummary reports the unattributed axis in every combination', () => {
    setShowUnattributed(false);
    assert.deepEqual(attribution.repScopeSummary(), {
      active: true, visible: 3, total: 3, hidden: 0, visibleRepIds: null, showUnattributed: false,
    });

    setScope(ONLY_SP1);
    assert.deepEqual(attribution.repScopeSummary(), {
      active: true, visible: 1, total: 3, hidden: 2, visibleRepIds: ['SP1'], showUnattributed: false,
    });
  });

  test('the rollups drop the unattributed row and its money', () => {
    setShowUnattributed(false);
    const out = performance.summary('2026-05');

    assert.equal(out.rows.some((r) => r.rep_id === null), false, 'no "Unattributed" row');
    assert.equal(out.totals.sales, 3000, '3500 less the 500 unattributed invoice');

    setScope(ONLY_SP1);
    assert.equal(performance.summary('2026-05').totals.sales, 1000, 'SP1 alone');
    assert.equal(performance.brandRollup({ months: 1, endMonth: '2026-05' }).total, 1000);
    assert.equal(performance.products({ month: '2026-05' }).totals.revenue, 1000);
  });

  test('dormant, cheques and focus drop their unattributed rows too', () => {
    cheques.createCheque({ customer_id: 'C1', amount: 100, deposit_date: '2026-06-10' });
    cheques.createCheque({ customer_id: 'C3', amount: 300, deposit_date: '2026-06-10' });
    focus.createFocus({ month: '2026-06', customer_id: 'C1' });
    focus.createFocus({ month: '2026-06', customer_id: 'C3' });

    setScope(ONLY_SP1);
    setShowUnattributed(false);

    assert.deepEqual(
      dormant.listDormant({ months: 3, now: new Date('2026-11-01T10:00:00') }).rows.map((r) => r.id),
      ['C1']
    );
    assert.deepEqual(cheques.listCheques().rows.map((r) => r.customer_id), ['C1']);
    assert.deepEqual(focus.listFocus('2026-06').rows.map((r) => r.customer_id), ['C1']);
  });

  test('an unattributed customer already reached nobody, and still does', () => {
    // C3 has no rep, so its overdue invoice was never routed to a digest even
    // when visible — confirmed both ways rather than redesigned
    const visible = engine.evaluate({ date: '2026-06-01', now: new Date('2026-06-01T09:00:00') });
    assert.equal(visible.stats.overdue.unrouted, 1);
    assert.equal(
      visible.digests.some((d) => d.sections.overdue.some((g) => g.customer_id === 'C3')),
      false
    );

    setShowUnattributed(false);
    const hidden = engine.evaluate({ date: '2026-06-01', now: new Date('2026-06-01T09:00:00') });
    assert.equal(hidden.stats.overdue.unrouted, 0, 'now it is filtered out before routing');
    assert.equal(
      hidden.digests.some((d) => d.sections.overdue.some((g) => g.customer_id === 'C3')),
      false
    );
    // the reps themselves are unaffected
    assert.deepEqual(hidden.digests.map((d) => d.rep.id).sort(), ['SP1', 'SP2']);
  });
});

// ===========================================================================
// performance
// ===========================================================================

describe('scope: performance rollups', () => {
  beforeEach(() => seedWorld());

  test('summary counts every rep when the scope is off', () => {
    const out = performance.summary('2026-05');
    assert.equal(out.totals.sales, 3500);
    assert.deepEqual(out.rows.map((r) => r.rep_id).sort(), ['SP1', 'SP2', null].sort());
  });

  test('summary drops the hidden rep and keeps the unattributed row', () => {
    setScope(ONLY_SP1);
    const out = performance.summary('2026-05');
    const byRep = new Map(out.rows.map((r) => [r.rep_id, r]));

    assert.equal(byRep.has('SP2'), false, 'hidden rep is gone');
    assert.equal(byRep.get('SP1').sales, 1000);
    assert.equal(byRep.get(null).sales, 500, 'unattributed still reported');
    assert.equal(out.totals.sales, 1500, '2000 of hidden sales excluded');
  });

  test("a hidden rep's target cannot conjure a row in a scoped summary", () => {
    getDb()
      .prepare("INSERT INTO targets (salesperson_id, month, brand_id, target_amount) VALUES ('SP2', '2026-05', NULL, 9999)")
      .run();
    setScope(ONLY_SP1);
    const out = performance.summary('2026-05');
    assert.equal(out.rows.some((r) => r.rep_id === 'SP2'), false);
    assert.equal(out.totals.target, 0);
  });

  test('mom, products and the brand rollup all honour the scope', () => {
    setScope(ONLY_SP1);

    const mom = performance.mom({ months: 1, endMonth: '2026-05' });
    assert.equal(mom.series.some((s) => s.rep_id === 'SP2'), false);
    assert.equal(mom.series.reduce((n, s) => n + s.total, 0), 1500);

    const products = performance.products({ month: '2026-05' });
    assert.equal(products.totals.revenue, 1500);
    assert.equal(products.rows[0].quantity, 2, 'only C1 (1) + C3 (1) widgets');

    const brands = performance.brandRollup({ months: 1, endMonth: '2026-05' });
    assert.equal(brands.total, 1500);
  });

  test('the pending-line-item count is scoped too', () => {
    addInvoice('I4', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-05-08', total: 10 });
    addInvoice('I5', { customer: 'C2', rep: 'SP2', repName: 'Priya Nair', date: '2026-05-09', total: 20 });

    assert.equal(performance.summary('2026-05').pendingInvoices, 2);
    setScope(ONLY_SP1);
    assert.equal(performance.summary('2026-05').pendingInvoices, 1, "the hidden rep's pending invoice is not our problem");
  });

  test('the targets grid offers only in-scope reps and only their rows', () => {
    getDb()
      .prepare("INSERT INTO targets (salesperson_id, month, brand_id, target_amount) VALUES ('SP2', '2026-05', NULL, 500)")
      .run();
    setScope(ONLY_SP1);
    const grid = performance.getTargets('2026-05');
    assert.deepEqual(grid.reps.map((r) => r.id), ['SP1']);
    assert.equal(grid.rows.length, 0);
  });

  test('setting a target for a hidden rep is a clear 400, not a silent write', () => {
    setScope(ONLY_SP1);
    assert.throws(
      () => performance.upsertTargets('2026-05', [{ salesperson_id: 'SP2', brand_id: null, target_amount: 100 }]),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /hidden by the current rep visibility scope/);
        return true;
      }
    );
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM targets').get().n, 0);
  });
});

// ===========================================================================
// phase-3 workflows
// ===========================================================================

describe('scope: dormant, cheques, focus', () => {
  beforeEach(() => seedWorld());

  const NOV = new Date('2026-11-01T10:00:00');

  test('the dormant list and its dashboard count are scoped', () => {
    assert.equal(dormant.listDormant({ months: 3, now: NOV }).total, 3);
    assert.equal(dormant.dormantCount({ months: 3, now: NOV }).count, 3);

    setScope(ONLY_SP1);
    const list = dormant.listDormant({ months: 3, now: NOV });
    assert.deepEqual(list.rows.map((r) => r.id).sort(), ['C1', 'C3']);
    assert.equal(dormant.dormantCount({ months: 3, now: NOV }).count, 2);
  });

  test("a cheque follows its customer, not the rep pinned on the cheque", () => {
    cheques.createCheque({ customer_id: 'C1', amount: 100, deposit_date: '2026-06-10' });
    // pinned to the VISIBLE rep but owned by the HIDDEN rep's customer
    cheques.createCheque({ customer_id: 'C2', amount: 200, deposit_date: '2026-06-10', salesperson_id: 'SP1' });
    cheques.createCheque({ customer_id: 'C3', amount: 300, deposit_date: '2026-06-10' });

    assert.equal(cheques.listCheques().rows.length, 3);

    setScope(ONLY_SP1);
    const rows = cheques.listCheques().rows;
    assert.deepEqual(rows.map((r) => r.customer_id).sort(), ['C1', 'C3']);
    assert.equal(cheques.chequeSummary().pending.count, 2);
    assert.equal(cheques.statusCounts().pending, 2);
    assert.deepEqual(
      cheques.chequesDueInDays(0, { now: new Date('2026-06-10T10:00:00') }).map((c) => c.customer_id).sort(),
      ['C1', 'C3']
    );
  });

  test('a hidden customer cannot be reached by id, and cannot take a new cheque', () => {
    const hidden = cheques.createCheque({ customer_id: 'C2', amount: 200, deposit_date: '2026-06-10' });
    setScope(ONLY_SP1);

    assert.equal(cheques.getCheque(hidden.id), undefined);
    assert.throws(
      () => cheques.createCheque({ customer_id: 'C2', amount: 50, deposit_date: '2026-06-11' }),
      /customer not found/
    );
  });

  test("a hidden cheque cannot be edited or deleted by guessing its id", () => {
    const hidden = cheques.createCheque({ customer_id: 'C2', amount: 200, deposit_date: '2026-06-10' });
    const mine = cheques.createCheque({ customer_id: 'C1', amount: 100, deposit_date: '2026-06-10' });
    setScope(ONLY_SP1);

    assert.throws(() => cheques.updateCheque(hidden.id, { amount: 1 }), /cheque not found/);
    assert.throws(() => cheques.deleteCheque(hidden.id), /cheque not found/);
    assert.equal(getDb().prepare('SELECT amount FROM cheques WHERE id = ?').get(hidden.id).amount, 200);

    // ...while an in-scope cheque still edits normally
    assert.equal(cheques.updateCheque(mine.id, { amount: 150 }).amount, 150);
  });

  test('a hidden focus row cannot be edited or deleted by guessing its id', () => {
    const hidden = focus.createFocus({ month: '2026-06', customer_id: 'C2' });
    setScope(ONLY_SP1);

    assert.throws(() => focus.updateFocus(hidden.id, { status: 'done' }), /focus item not found/);
    assert.throws(() => focus.deleteFocus(hidden.id), /focus item not found/);
    assert.equal(getDb().prepare('SELECT status FROM focus_plans WHERE id = ?').get(hidden.id).status, 'open');
  });

  test('focus plan rows and the open count are scoped by their customer', () => {
    focus.createFocus({ month: '2026-06', customer_id: 'C1' });
    focus.createFocus({ month: '2026-06', customer_id: 'C2', salesperson_id: 'SP1' });
    focus.createFocus({ month: '2026-06', customer_id: 'C3' });

    assert.equal(focus.listFocus('2026-06').rows.length, 3);

    setScope(ONLY_SP1);
    const list = focus.listFocus('2026-06');
    assert.deepEqual(list.rows.map((r) => r.customer_id).sort(), ['C1', 'C3']);
    assert.equal(list.counts.total, 2);
    assert.equal(focus.openFocusCount('2026-06').open, 2);
    assert.equal(focus.openFocusCount('2026-06').total, 2);

    assert.throws(() => focus.createFocus({ month: '2026-07', customer_id: 'C2' }), /customer not found/);
  });
});

// ===========================================================================
// the reminder engine
// ===========================================================================

describe('scope: reminder engine', () => {
  beforeEach(() => seedWorld());

  const RUN = { date: '2026-06-01', now: new Date('2026-06-01T09:00:00') };

  test('unscoped, both reps get a digest carrying their own customer', () => {
    const out = engine.evaluate(RUN);
    const byRep = new Map(out.digests.map((d) => [d.rep.id, d]));

    assert.deepEqual([...byRep.keys()].sort(), ['SP1', 'SP2']);
    assert.deepEqual(byRep.get('SP1').sections.overdue.map((g) => g.customer_id), ['C1']);
    assert.deepEqual(byRep.get('SP2').sections.overdue.map((g) => g.customer_id), ['C2']);
  });

  test('a hidden rep gets no digest at all', () => {
    setScope(ONLY_SP1);
    const out = engine.evaluate(RUN);

    assert.deepEqual(out.digests.map((d) => d.rep.id), ['SP1']);
    assert.equal(engine.digestReps().some((r) => r.id === 'SP2'), false);
    assert.equal(out.stats.reps, 1);
  });

  test("a hidden customer's overdue invoices appear in NOBODY's digest", () => {
    // hand Beta Bikes to the visible rep's namesake? No — pin the plan row to
    // SP1 and prove the CUSTOMER's scope still wins.
    setScope(ONLY_SP1);
    const out = engine.evaluate(RUN);

    const everyCustomer = out.digests.flatMap((d) => d.sections.overdue.map((g) => g.customer_id));
    assert.equal(everyCustomer.includes('C2'), false, 'C2 belongs to a hidden rep');
    assert.deepEqual(everyCustomer, ['C1']);

    // and the rendered text cannot mention them either
    assert.equal(out.digests.some((d) => d.text.includes('Beta Bikes')), false);
  });

  test('an unattributed overdue invoice stays unrouted — visible, but nobody is nagged', () => {
    setScope(ONLY_SP1);
    const out = engine.evaluate(RUN);
    assert.equal(out.stats.overdue.unrouted, 1, 'C3 has no rep to send it to');
    assert.equal(out.digests.some((d) => d.sections.overdue.some((g) => g.customer_id === 'C3')), false);
  });

  test('a hidden rep with a cheque and a dormant customer still gets nothing', () => {
    cheques.createCheque({ customer_id: 'C2', amount: 500, deposit_date: '2026-06-04' });
    setScope(ONLY_SP1);

    const out = engine.evaluate({ date: '2026-06-01', now: new Date('2026-06-01T09:00:00') });
    assert.equal(out.digests.some((d) => d.rep.id === 'SP2'), false);
    assert.equal(out.digests.some((d) => d.sections.cheques.length), false);
  });

  test('digestStatus only reports the reps in scope', () => {
    setScope(ONLY_SP1);
    const status = engine.digestStatus({ now: new Date('2026-06-01T09:00:00') });
    assert.deepEqual(status.today.reps.map((r) => r.rep_id), ['SP1']);
  });
});

// ===========================================================================
// HTTP surface
// ===========================================================================

describe('scope: API routes', () => {
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
    const res = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    assert.equal(res.status, 200);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    seedWorld();
  });

  async function call(method, pathname, body) {
    const res = await fetch(origin + pathname, {
      method,
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

  // --- settings round-trip -------------------------------------------------

  test('the setting round-trips through /api/settings and defaults to null', async () => {
    const initial = await call('GET', '/api/settings');
    assert.equal(initial.json.settings.visible_rep_ids, null);
    assert.equal(initial.json.repScope.active, false);

    const put = await call('PUT', '/api/settings', { visible_rep_ids: ['SP1', 'SP3'] });
    assert.equal(put.status, 200);
    assert.deepEqual(put.json.settings.visible_rep_ids, ['SP1', 'SP3']);
    assert.deepEqual(put.json.repScope, {
      active: true, visible: 2, total: 3, hidden: 1, visibleRepIds: ['SP1', 'SP3'], showUnattributed: true,
    });

    const back = await call('GET', '/api/settings');
    assert.deepEqual(back.json.settings.visible_rep_ids, ['SP1', 'SP3']);

    const cleared = await call('PUT', '/api/settings', { visible_rep_ids: null });
    assert.equal(cleared.json.settings.visible_rep_ids, null);
    assert.equal(cleared.json.repScope.active, false);
  });

  test('duplicates collapse and a malformed id is a 400', async () => {
    const dupes = await call('PUT', '/api/settings', { visible_rep_ids: ['SP1', 'SP1', 'SP2'] });
    assert.deepEqual(dupes.json.settings.visible_rep_ids, ['SP1', 'SP2']);

    const bad = await call('PUT', '/api/settings', { visible_rep_ids: ["oops'; DROP TABLE customers; --"] });
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.json), /not a valid salesperson id/);

    const notArray = await call('PUT', '/api/settings', { visible_rep_ids: 'SP1' });
    assert.equal(notArray.status, 400);

    await call('PUT', '/api/settings', { visible_rep_ids: null });
  });

  // --- lists ---------------------------------------------------------------

  test('customers, invoices and payments lists are filtered; unattributed survives', async () => {
    await call('PUT', '/api/settings', { visible_rep_ids: ['SP1'] });

    const customers = await call('GET', '/api/customers');
    assert.deepEqual(customers.json.rows.map((r) => r.id).sort(), ['C1', 'C3']);
    assert.equal(customers.json.total, 2);

    const invoices = await call('GET', '/api/invoices');
    assert.deepEqual(invoices.json.rows.map((r) => r.id).sort(), ['I1', 'I3']);
    assert.equal(invoices.json.totals.amount, 1500);

    const payments = await call('GET', '/api/payments');
    assert.deepEqual(payments.json.rows.map((r) => r.id).sort(), ['P1', 'P3']);
    assert.equal(payments.json.totals.amount, 400);

    await call('PUT', '/api/settings', { visible_rep_ids: null });
  });

  test('a hidden customer and a hidden invoice 404 instead of leaking', async () => {
    await call('PUT', '/api/settings', { visible_rep_ids: ['SP1'] });

    assert.equal((await call('GET', '/api/customers/C1')).status, 200);
    assert.equal((await call('GET', '/api/customers/C3')).status, 200);

    const hiddenCustomer = await call('GET', '/api/customers/C2');
    assert.equal(hiddenCustomer.status, 404);
    assert.equal(hiddenCustomer.json.error, 'customer not found');

    assert.equal((await call('GET', '/api/customers/C2/assignments')).status, 404);
    assert.equal((await call('GET', '/api/invoices/I2')).status, 404);
    assert.equal((await call('GET', '/api/invoices/I1')).status, 200);

    await call('PUT', '/api/settings', { visible_rep_ids: null });
  });

  test('the reassignment dropdown offers only visible reps', async () => {
    await call('PUT', '/api/settings', { visible_rep_ids: ['SP1'] });
    const res = await call('GET', '/api/customers/C1/assignments');
    assert.deepEqual(res.json.reps.map((r) => r.id), ['SP1']);
    await call('PUT', '/api/settings', { visible_rep_ids: null });
  });

  test('every dashboard KPI is filtered', async () => {
    const before = await call('GET', '/api/dashboard');
    assert.equal(before.json.kpis.customers.total, 3);
    assert.equal(before.json.kpis.outstanding.amount, 3500);

    await call('PUT', '/api/settings', { visible_rep_ids: ['SP1'] });
    const after = await call('GET', '/api/dashboard');

    assert.equal(after.json.kpis.customers.total, 2);
    assert.equal(after.json.kpis.outstanding.amount, 1500);
    assert.equal(after.json.kpis.overdue.amount, 1500);
    assert.deepEqual(after.json.topOutstanding.map((c) => c.id).sort(), ['C1', 'C3']);
    assert.deepEqual(after.json.recentInvoices.map((i) => i.id).sort(), ['I1', 'I3']);
    assert.equal(after.json.repScope.active, true);
    assert.equal(after.json.repScope.visible, 1);

    await call('PUT', '/api/settings', { visible_rep_ids: null });
  });

  test('the Reps page always lists every rep, flagged with its visibility', async () => {
    await call('PUT', '/api/settings', { visible_rep_ids: ['SP1'] });

    const reps = await call('GET', '/api/reps');
    assert.equal(reps.json.rows.length, 3, 'you must be able to un-hide a rep');
    assert.deepEqual(
      reps.json.rows.filter((r) => r.visible).map((r) => r.id),
      ['SP1']
    );
    assert.equal(reps.json.repScope.hidden, 2);

    await call('PUT', '/api/settings', { visible_rep_ids: null });
  });

  test('the targets grid rejects a hidden rep with a 400 that says why', async () => {
    await call('PUT', '/api/settings', { visible_rep_ids: ['SP1'] });
    const res = await call('PUT', '/api/targets', {
      month: '2026-05',
      rows: [{ salesperson_id: 'SP2', brand_id: null, target_amount: 1000 }],
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /hidden by the current rep visibility scope/);
    await call('PUT', '/api/settings', { visible_rep_ids: null });
  });

  test('the invoice filter bar only describes visible data', async () => {
    await call('PUT', '/api/settings', { visible_rep_ids: ['SP1'] });
    const meta = await call('GET', '/api/invoices/meta/filters');
    assert.deepEqual(meta.json.salespersons.map((s) => s.id), ['SP1']);
    assert.equal(meta.json.statuses.reduce((n, s) => n + s.n, 0), 2);
    await call('PUT', '/api/settings', { visible_rep_ids: null });
  });

  test('show_unattributed round-trips and defaults to true', async () => {
    const initial = await call('GET', '/api/settings');
    assert.equal(initial.json.settings.show_unattributed, true);
    assert.equal(initial.json.repScope.showUnattributed, true);
    assert.equal(initial.json.repScope.active, false);

    const off = await call('PUT', '/api/settings', { show_unattributed: false });
    assert.equal(off.status, 200);
    assert.equal(off.json.settings.show_unattributed, false);
    assert.equal(off.json.repScope.active, true, 'hiding unattributed alone activates the filter');
    assert.equal(off.json.repScope.hidden, 0, '...without hiding any rep');

    const back = await call('GET', '/api/settings');
    assert.equal(back.json.settings.show_unattributed, false);

    await call('PUT', '/api/settings', { show_unattributed: true });
  });

  test('hiding unattributed alone filters the lists but keeps every rep', async () => {
    await call('PUT', '/api/settings', { show_unattributed: false });

    const customers = await call('GET', '/api/customers');
    assert.deepEqual(customers.json.rows.map((r) => r.id).sort(), ['C1', 'C2'], 'C3 has no rep');

    const invoices = await call('GET', '/api/invoices');
    assert.deepEqual(invoices.json.rows.map((r) => r.id).sort(), ['I1', 'I2']);
    assert.equal(invoices.json.totals.amount, 3000);

    const payments = await call('GET', '/api/payments');
    assert.deepEqual(payments.json.rows.map((r) => r.id).sort(), ['P1', 'P2']);

    const dash = await call('GET', '/api/dashboard');
    assert.equal(dash.json.kpis.customers.total, 2);
    assert.equal(dash.json.kpis.outstanding.amount, 3000);

    // the unattributed customer is now a 404, the rep-owned ones are not
    assert.equal((await call('GET', '/api/customers/C3')).status, 404);
    assert.equal((await call('GET', '/api/invoices/I3')).status, 404);
    assert.equal((await call('GET', '/api/customers/C2')).status, 200);
    assert.equal((await call('GET', '/api/invoices/I2')).status, 200);

    await call('PUT', '/api/settings', { show_unattributed: true });
  });

  test('both axes at once: one rep, no unattributed', async () => {
    await call('PUT', '/api/settings', { visible_rep_ids: ['SP1'], show_unattributed: false });

    const customers = await call('GET', '/api/customers');
    assert.deepEqual(customers.json.rows.map((r) => r.id), ['C1']);

    const reps = await call('GET', '/api/reps');
    assert.equal(reps.json.rows.length, 3, 'the Reps page still shows everyone');
    assert.equal(reps.json.repScope.showUnattributed, false);
    assert.equal(reps.json.repScope.hidden, 2);

    await call('PUT', '/api/settings', { visible_rep_ids: null, show_unattributed: true });
  });

  test('with the scope off every route reports everything again', async () => {
    const customers = await call('GET', '/api/customers');
    assert.equal(customers.json.total, 3);
    const invoices = await call('GET', '/api/invoices');
    assert.equal(invoices.json.totals.amount, 3500);
    const dash = await call('GET', '/api/dashboard');
    assert.equal(dash.json.repScope.active, false);
  });
});
