'use strict';

/**
 * Phase 2 unit tests — brand rules engine, effective-rep attribution,
 * performance rollups and the targets grid.
 *
 * No network, no live credentials: everything runs against a throwaway SQLite
 * file seeded row-by-row so every expected total below is hand-computed.
 *   npm test --workspace=server
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

// point config at a scratch database BEFORE anything requires it
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcrm-p2-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DATA_DIR = TMP_DIR;
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const config = require('../src/config');
const brands = require('../src/services/brands');
const attribution = require('../src/services/attribution');
const perf = require('../src/services/performance');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const TABLES = [
  'item_brand_map',
  'brand_rules',
  'brands',
  'customer_rep_assignments',
  'targets',
  'invoice_line_items',
  'payments',
  'invoices',
  'items',
  'customers',
  'salespersons',
  'sync_state',
];

function resetDb() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('brands','brand_rules','targets','customer_rep_assignments')");
  db.exec('PRAGMA foreign_keys = ON');
}

function addRep(id, name, extra = {}) {
  getDb()
    .prepare('INSERT INTO salespersons (zoho_salesperson_id, name, email, is_active) VALUES (?, ?, ?, ?)')
    .run(id, name, extra.email || null, extra.is_active === undefined ? 1 : extra.is_active);
  return id;
}

function addCustomer(id, name) {
  getDb().prepare('INSERT INTO customers (zoho_contact_id, contact_name) VALUES (?, ?)').run(id, name);
  return id;
}

function addItem(id, { name = '', sku = null, category = null, customFields = null } = {}) {
  getDb()
    .prepare(
      'INSERT INTO items (zoho_item_id, name, sku, category_name, custom_fields_json) VALUES (?, ?, ?, ?, ?)'
    )
    .run(id, name, sku, category, customFields ? JSON.stringify(customFields) : null);
  return id;
}

function addBrand(name, sortOrder = 0) {
  const info = getDb().prepare('INSERT INTO brands (name, sort_order) VALUES (?, ?)').run(name, sortOrder);
  return Number(info.lastInsertRowid);
}

function addRule(brandId, ruleType, matchValue, priority, extra = {}) {
  const info = getDb()
    .prepare(
      `INSERT INTO brand_rules (brand_id, rule_type, custom_field_name, match_value, priority, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(brandId, ruleType, extra.customFieldName || null, matchValue, priority, extra.isActive === undefined ? 1 : extra.isActive);
  return Number(info.lastInsertRowid);
}

function addInvoice(id, { customer, rep = null, repName = null, date, total, status = 'sent', lines = [] }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO invoices (zoho_invoice_id, invoice_number, customer_id, customer_name,
       salesperson_id, salesperson_name, invoice_date, due_date, status, total, sub_total, balance,
       line_items_synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, id, customer, customer, rep, repName, date, date, status, total, total, 0, lines.length ? 1 : 0);

  lines.forEach((li, idx) => {
    db.prepare(
      `INSERT INTO invoice_line_items (zoho_line_item_id, invoice_id, item_id, line_order, name, sku,
         quantity, rate, item_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(`${id}-L${idx + 1}`, id, li.item_id || null, idx, li.name || '', li.sku || null, li.quantity ?? 1, li.rate ?? 0, li.item_total);
  });
  return id;
}

const mapOf = () =>
  new Map(getDb().prepare('SELECT item_id, brand_id, source, rule_id FROM item_brand_map').all().map((r) => [r.item_id, r]));

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

// ===========================================================================
// brand rules engine
// ===========================================================================

describe('brands: rule matching', () => {
  test('category matches exactly (case-insensitively), not as a substring', () => {
    const rule = { rule_type: 'category', match_value: 'Frames' };
    assert.equal(brands.ruleMatchesItem(rule, { category_name: 'frames' }), true);
    assert.equal(brands.ruleMatchesItem(rule, { category_name: 'Frames' }), true);
    assert.equal(brands.ruleMatchesItem(rule, { category_name: 'Alloy Frames Pro' }), false);
    assert.equal(brands.ruleMatchesItem(rule, { category_name: null }), false);
  });

  test('a *_pattern with no wildcard means "contains"', () => {
    const rule = { rule_type: 'name_pattern', match_value: 'Tyre' };
    assert.equal(brands.ruleMatchesItem(rule, { name: 'Tubeless Tyre 29x2.2' }), true);
    assert.equal(brands.ruleMatchesItem(rule, { name: 'Helmet' }), false);
  });

  test('% and * are wildcards in a pattern', () => {
    assert.equal(brands.ruleMatchesItem({ rule_type: 'sku_pattern', match_value: 'HLM-%' }, { sku: 'HLM-PRO' }), true);
    assert.equal(brands.ruleMatchesItem({ rule_type: 'sku_pattern', match_value: 'HLM-%' }, { sku: 'XHLM-PRO' }), false);
    assert.equal(brands.ruleMatchesItem({ rule_type: 'sku_pattern', match_value: 'TYR*' }, { sku: 'TYR-29' }), true);
  });

  test('custom_field reads the named field out of custom_fields_json', () => {
    const item = {
      custom_fields_json: JSON.stringify([
        { label: 'Warranty', value: '2 years' },
        { label: 'Brand', api_name: 'cf_brand', value: 'Battalion' },
      ]),
    };
    const rule = { rule_type: 'custom_field', custom_field_name: 'Brand', match_value: 'Battalion' };
    assert.equal(brands.ruleMatchesItem(rule, item), true);
    assert.equal(brands.ruleMatchesItem({ ...rule, custom_field_name: 'cf_brand' }, item), true);
    assert.equal(brands.ruleMatchesItem({ ...rule, match_value: 'Velocity' }, item), false);
    assert.equal(brands.ruleMatchesItem({ ...rule, custom_field_name: 'Colour' }, item), false);
  });
});

describe('brands: remap precedence, manual overrides, idempotency', () => {
  let B1;
  let B2;

  beforeEach(() => {
    B1 = addBrand('Battalion', 1);
    B2 = addBrand('Velocity', 2);
    addItem('I1', { name: 'Alloy MTB Frame', sku: 'FRM-1', category: 'Frames', customFields: [{ label: 'Brand', value: 'Battalion' }] });
    addItem('I2', { name: 'Tubeless Tyre 29', sku: 'TYR-1', category: 'Tyres' });
    addItem('I3', { name: 'Helmet Pro Vent', sku: 'HLM-1', category: 'Accessories' });
    addItem('I4', { name: 'Mystery Widget', sku: 'WID-1', category: 'Misc' });
  });

  test('the lowest priority number wins, not the first row inserted', () => {
    addRule(B1, 'category', 'Frames', 10); // inserted first...
    const skuRule = addRule(B2, 'sku_pattern', 'FRM-%', 5); // ...but this one is higher precedence
    addRule(B2, 'name_pattern', '%Tyre%', 20);

    const stats = brands.remapItems();
    const map = mapOf();

    assert.equal(map.get('I1').brand_id, B2, 'priority 5 beats priority 10');
    assert.equal(map.get('I1').rule_id, skuRule);
    assert.equal(map.get('I2').brand_id, B2);
    assert.equal(map.has('I3'), false);
    assert.equal(map.has('I4'), false);
    assert.deepEqual(
      { matched: stats.matched, unmapped: stats.unmapped, inserted: stats.inserted },
      { matched: 2, unmapped: 2, inserted: 2 }
    );
  });

  test('re-running the rules is idempotent — no writes the second time', () => {
    addRule(B1, 'category', 'Frames', 10);
    addRule(B2, 'name_pattern', '%Tyre%', 20);

    const first = brands.remapItems();
    const second = brands.remapItems();

    assert.equal(first.changed, 2);
    assert.equal(second.changed, 0);
    assert.equal(second.inserted + second.updated + second.cleared, 0);
    assert.deepEqual(mapOf().get('I1').brand_id, B1);
  });

  test('a manual mapping survives every remap, including a rule that would claim it', () => {
    addRule(B1, 'category', 'Frames', 10);
    brands.remapItems();
    assert.equal(mapOf().get('I1').source, 'rule');

    brands.setItemBrand('I1', B2); // admin overrides the rule
    assert.equal(mapOf().get('I1').source, 'manual');
    assert.equal(mapOf().get('I1').brand_id, B2);

    // a brand-new, higher-precedence rule must still not touch it
    addRule(B1, 'sku_pattern', 'FRM-%', 1);
    const stats = brands.remapItems();

    assert.equal(stats.manual, 1);
    assert.equal(mapOf().get('I1').source, 'manual');
    assert.equal(mapOf().get('I1').brand_id, B2);
  });

  test('a manual mapping on an item no rule claims is kept, and null reverts to the rules', () => {
    addRule(B1, 'category', 'Frames', 10);
    brands.remapItems();

    brands.setItemBrand('I4', B2);
    brands.remapItems();
    assert.equal(mapOf().get('I4').brand_id, B2);

    // reverting: I4 matches nothing → unmapped again
    brands.setItemBrand('I4', null);
    assert.equal(mapOf().has('I4'), false);

    // reverting an item that DOES match a rule hands it back to that rule
    brands.setItemBrand('I1', B2);
    assert.equal(mapOf().get('I1').source, 'manual');
    brands.setItemBrand('I1', null);
    assert.equal(mapOf().get('I1').source, 'rule');
    assert.equal(mapOf().get('I1').brand_id, B1);
  });

  test('removing a rule clears the rows it created but not the manual ones', () => {
    const ruleId = addRule(B1, 'category', 'Frames', 10);
    addRule(B2, 'name_pattern', '%Tyre%', 20);
    brands.remapItems();
    brands.setItemBrand('I3', B1);

    brands.deleteRule(ruleId);
    const map = mapOf();

    assert.equal(map.has('I1'), false, 'rule-mapped item is released');
    assert.equal(map.get('I2').brand_id, B2, 'other rules keep working');
    assert.equal(map.get('I3').source, 'manual', 'manual mapping is untouched');
  });

  test('deactivating a brand takes its rules out of play', () => {
    addRule(B1, 'category', 'Frames', 10);
    addRule(B2, 'name_pattern', '%Tyre%', 20);
    brands.remapItems();
    assert.equal(mapOf().size, 2);

    brands.updateBrand(B1, { is_active: false });
    const map = mapOf();
    assert.equal(map.has('I1'), false);
    assert.equal(map.get('I2').brand_id, B2);
  });

  test('inactive rules are skipped and unmapped items are queryable', () => {
    addRule(B1, 'category', 'Frames', 10, { isActive: 0 });
    addRule(B2, 'name_pattern', '%Tyre%', 20);
    brands.remapItems();

    const { rows, total } = brands.unmappedItems();
    const ids = rows.map((r) => r.id).sort();
    assert.equal(total, 3);
    assert.deepEqual(ids, ['I1', 'I3', 'I4']);
    assert.deepEqual(brands.mappingStats(), { items: 4, mapped: 1, manual: 0, unmapped: 3 });
  });
});

// ===========================================================================
// attribution
// ===========================================================================

describe('attribution: effective rep', () => {
  const AT = (d) => new Date(`${d}T10:00:00`);

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addRep('SP2', 'Priya Nair');
    addRep('SP3', 'Rahul Desai');
    addCustomer('C1', 'Sharma Cycle Mart');
    addInvoice('OLD', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-01-15', total: 1000 });
    addInvoice('NEW', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-06-15', total: 2000 });
  });

  const repOf = (id) => attribution.invoiceRep(id).rep_id;

  test('with no assignment the invoice keeps its own salesperson', () => {
    assert.equal(repOf('OLD'), 'SP1');
    assert.equal(repOf('NEW'), 'SP1');
  });

  test('an unknown salesperson_id falls back to a name match', () => {
    addInvoice('BYNAME', { customer: 'C1', rep: 'SP-GONE', repName: 'priya nair', date: '2026-03-01', total: 100 });
    assert.equal(repOf('BYNAME'), 'SP2');
  });

  test('an invoice whose salesperson matches nothing is left unattributed', () => {
    addInvoice('ORPHAN', { customer: 'C1', rep: null, repName: 'Someone Else', date: '2026-03-01', total: 100 });
    assert.equal(repOf('ORPHAN'), null);
  });

  test("'from today' moves only invoices dated on/after the effective date", () => {
    attribution.assignCustomer('C1', 'SP2', 'from_today', 'swap', { now: AT('2026-04-01') });

    assert.equal(repOf('OLD'), 'SP1', 'invoice before effective_from stays put');
    assert.equal(repOf('NEW'), 'SP2', 'invoice after effective_from moves');

    const rows = attribution.listAssignments('C1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].effective_from, '2026-04-01');
    assert.equal(rows[0].effective_to, null);
    assert.equal(rows[0].mode, 'from_today');
  });

  test('an invoice dated exactly on effective_from belongs to the new rep', () => {
    addInvoice('ONDAY', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-04-01', total: 50 });
    attribution.assignCustomer('C1', 'SP2', 'from_today', null, { now: AT('2026-04-01') });
    assert.equal(repOf('ONDAY'), 'SP2');
  });

  test("'all history' moves every invoice, past and future", () => {
    attribution.assignCustomer('C1', 'SP3', 'all_history', 'always was Rahul', { now: AT('2026-04-01') });

    assert.equal(repOf('OLD'), 'SP3');
    assert.equal(repOf('NEW'), 'SP3');
    assert.equal(attribution.listAssignments('C1')[0].effective_from, attribution.ALL_HISTORY_FROM);
  });

  test("'all history' supersedes an earlier 'from today' rather than fighting it", () => {
    attribution.assignCustomer('C1', 'SP2', 'from_today', null, { now: AT('2026-04-01') });
    attribution.assignCustomer('C1', 'SP3', 'all_history', null, { now: AT('2026-05-01') });

    assert.equal(repOf('OLD'), 'SP3');
    assert.equal(repOf('NEW'), 'SP3');

    const rows = attribution.listAssignments('C1');
    assert.equal(rows.length, 2, 'history is kept, not deleted');
    assert.equal(rows.filter((r) => r.is_active).length, 1);
  });

  test('deleting an assignment restores exactly what it replaced', () => {
    const first = attribution.assignCustomer('C1', 'SP2', 'from_today', null, { now: AT('2026-04-01') });
    const second = attribution.assignCustomer('C1', 'SP3', 'all_history', null, { now: AT('2026-05-01') });

    // undo the all-history move → back to the from-today split
    attribution.deleteAssignment(second.assignment.id);
    assert.equal(repOf('OLD'), 'SP1');
    assert.equal(repOf('NEW'), 'SP2');
    assert.equal(attribution.listAssignments('C1').length, 1);

    // undo the from-today move → back to the raw Zoho salesperson
    attribution.deleteAssignment(first.assignment.id);
    assert.equal(repOf('OLD'), 'SP1');
    assert.equal(repOf('NEW'), 'SP1');
    assert.equal(attribution.listAssignments('C1').length, 0);
  });

  test('a second "from today" closes the first and both stay in the history', () => {
    attribution.assignCustomer('C1', 'SP2', 'from_today', null, { now: AT('2026-03-01') });
    attribution.assignCustomer('C1', 'SP3', 'from_today', null, { now: AT('2026-05-01') });

    addInvoice('MID', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-04-10', total: 10 });
    addInvoice('LATE', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-05-20', total: 10 });

    assert.equal(repOf('OLD'), 'SP1'); // 2026-01-15, before anything
    assert.equal(repOf('MID'), 'SP2'); // inside the first window
    assert.equal(repOf('LATE'), 'SP3'); // after the second
    assert.equal(attribution.listAssignments('C1').length, 2);
  });

  test('currentRep reports the assignment, then falls back to the last invoice', () => {
    const fallback = attribution.currentRep('C1');
    assert.equal(fallback.source, 'invoice');
    assert.equal(fallback.salesperson_id, 'SP1');

    attribution.assignCustomer('C1', 'SP2', 'from_today');
    const assigned = attribution.currentRep('C1');
    assert.equal(assigned.source, 'assignment');
    assert.equal(assigned.salesperson_id, 'SP2');
  });

  test('assigning validates the customer and the rep', () => {
    assert.throws(() => attribution.assignCustomer('NOPE', 'SP1', 'from_today'), /customer not found/);
    assert.throws(() => attribution.assignCustomer('C1', 'NOPE', 'from_today'), /salesperson not found/);
    assert.throws(() => attribution.assignCustomer('C1', 'SP1', 'sideways'), /mode must be/);
  });
});

describe('attribution: rep config', () => {
  test('updateRep writes only the CRM-owned columns', () => {
    addRep('SP1', 'Anil Mehta', { email: 'anil@zoho.example' });
    const rep = attribution.updateRep('SP1', {
      crm_email: 'anil.crm@example.in',
      whatsapp_number: '+91 98765-43210',
      notify_whatsapp: true,
      notify_email: false,
      is_active: true,
    });

    assert.equal(rep.crm_email, 'anil.crm@example.in');
    assert.equal(rep.whatsapp_number, '919876543210', 'non-digits are stripped');
    assert.equal(rep.notify_whatsapp, true);
    assert.equal(rep.notify_email, false);

    const row = getDb().prepare('SELECT name, email FROM salespersons WHERE zoho_salesperson_id = ?').get('SP1');
    assert.equal(row.name, 'Anil Mehta', 'the Zoho name is untouched');
    assert.equal(row.email, 'anil@zoho.example');
  });
});

// ===========================================================================
// performance
// ===========================================================================

describe('performance: summary', () => {
  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addRep('SP2', 'Priya Nair');
    addCustomer('C1', 'Sharma Cycle Mart');
    addCustomer('C2', 'Velocity Bikes');

    // May 2026: SP1 = 1000 + 2000, SP2 = 500. The void invoice never counts.
    addInvoice('M1', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-05-04', total: 1000 });
    addInvoice('M2', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-05-18', total: 2000, status: 'paid' });
    addInvoice('M3', { customer: 'C2', rep: 'SP2', repName: 'Priya Nair', date: '2026-05-20', total: 500 });
    addInvoice('M4', { customer: 'C2', rep: 'SP2', repName: 'Priya Nair', date: '2026-05-22', total: 999, status: 'void' });
    // a different month, must not leak in
    addInvoice('A1', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-04-30', total: 7777 });

    getDb()
      .prepare('INSERT INTO targets (salesperson_id, month, brand_id, target_amount) VALUES (?, ?, NULL, ?)')
      .run('SP1', '2026-05', 4000);
    getDb()
      .prepare('INSERT INTO targets (salesperson_id, month, brand_id, target_amount) VALUES (?, ?, NULL, ?)')
      .run('SP2', '2026-05', 500);
  });

  test('per-rep sales, targets and achievement match the hand-computed totals', () => {
    const out = perf.summary('2026-05');
    const byRep = new Map(out.rows.map((r) => [r.rep_id, r]));

    assert.equal(byRep.get('SP1').sales, 3000);
    assert.equal(byRep.get('SP1').invoice_count, 2);
    assert.equal(byRep.get('SP1').target, 4000);
    assert.equal(byRep.get('SP1').achievement_pct, 75);
    assert.equal(byRep.get('SP1').delta, -1000);

    assert.equal(byRep.get('SP2').sales, 500);
    assert.equal(byRep.get('SP2').invoice_count, 1, 'the void invoice is not counted');
    assert.equal(byRep.get('SP2').achievement_pct, 100);
    assert.equal(byRep.get('SP2').delta, 0);

    assert.equal(out.totals.sales, 3500);
    assert.equal(out.totals.invoice_count, 3);
    assert.equal(out.totals.target, 4500);
  });

  test('a rep with a target but no sales still shows up at 0%', () => {
    getDb()
      .prepare('INSERT INTO targets (salesperson_id, month, brand_id, target_amount) VALUES (?, ?, NULL, ?)')
      .run('SP2', '2026-06', 1000);
    const out = perf.summary('2026-06');
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].rep_id, 'SP2');
    assert.equal(out.rows[0].sales, 0);
    assert.equal(out.rows[0].achievement_pct, 0);
  });

  test('re-attributing a customer moves its whole history between reps', () => {
    attribution.assignCustomer('C1', 'SP2', 'all_history', null, { now: new Date('2026-07-01T10:00:00') });
    const out = perf.summary('2026-05');
    const byRep = new Map(out.rows.map((r) => [r.rep_id, r]));

    assert.equal(byRep.get('SP2').sales, 3500);
    assert.equal(byRep.get('SP2').invoice_count, 3);
    assert.equal(byRep.get('SP1').sales, 0, 'SP1 keeps its target row but loses the sales');
    assert.equal(out.totals.sales, 3500, 'the month total is unchanged');
  });

  test('an unattributed invoice is surfaced as its own row, not dropped', () => {
    addInvoice('GHOST', { customer: 'C2', rep: null, repName: null, date: '2026-05-25', total: 250 });
    const out = perf.summary('2026-05');
    const ghost = out.rows.find((r) => r.rep_id === null);
    assert.ok(ghost, 'expected an "Unattributed" row');
    assert.equal(ghost.rep_name, 'Unattributed');
    assert.equal(ghost.sales, 250);
    assert.equal(out.totals.sales, 3750);
  });
});

describe('performance: month-on-month', () => {
  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addRep('SP2', 'Priya Nair');
    addCustomer('C1', 'Sharma Cycle Mart');
    addInvoice('J1', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-03-10', total: 100 });
    addInvoice('J2', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-04-10', total: 200 });
    addInvoice('J3', { customer: 'C1', rep: 'SP2', repName: 'Priya Nair', date: '2026-04-20', total: 300 });
    addInvoice('J4', { customer: 'C1', rep: 'SP2', repName: 'Priya Nair', date: '2026-05-20', total: 400, status: 'void' });
  });

  test('returns one point per month per rep, zero-filled', () => {
    const out = perf.mom({ months: 3, endMonth: '2026-05' });
    assert.deepEqual(out.months, ['2026-03', '2026-04', '2026-05']);

    const sp1 = out.series.find((s) => s.rep_id === 'SP1');
    assert.deepEqual(sp1.points.map((p) => p.amount), [100, 200, 0]);

    const sp2 = out.series.find((s) => s.rep_id === 'SP2');
    assert.deepEqual(sp2.points.map((p) => p.amount), [0, 300, 0], 'the void invoice contributes nothing');
  });

  test('filtering by rep returns only that series', () => {
    const out = perf.mom({ rep: 'SP2', months: 3, endMonth: '2026-05' });
    assert.equal(out.series.length, 1);
    assert.equal(out.series[0].rep_id, 'SP2');
  });
});

describe('performance: brand rollup and line-item gaps', () => {
  let B1;
  let B2;

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addCustomer('C1', 'Sharma Cycle Mart');
    B1 = addBrand('Battalion', 1);
    B2 = addBrand('Velocity', 2);
    addItem('I1', { name: 'Frame', sku: 'FRM-1', category: 'Frames' });
    addItem('I2', { name: 'Tyre', sku: 'TYR-1', category: 'Tyres' });
    addRule(B1, 'category', 'Frames', 10);
    addRule(B2, 'category', 'Tyres', 20);
    brands.remapItems();

    // total 1000 against 1000 of line value → brand split is 400 / 600
    addInvoice('WITH_LINES', {
      customer: 'C1',
      rep: 'SP1',
      repName: 'Anil Mehta',
      date: '2026-05-05',
      total: 1000,
      lines: [
        { item_id: 'I1', name: 'Frame', item_total: 400, quantity: 2 },
        { item_id: 'I2', name: 'Tyre', item_total: 600, quantity: 3 },
      ],
    });
    // total 1180 (18% GST) against 1000 of line value → pro-rata 708 / 472
    addInvoice('WITH_GST', {
      customer: 'C1',
      rep: 'SP1',
      repName: 'Anil Mehta',
      date: '2026-05-06',
      total: 1180,
      lines: [
        { item_id: 'I1', name: 'Frame', item_total: 600, quantity: 3 },
        { item_id: 'I2', name: 'Tyre', item_total: 400, quantity: 2 },
      ],
    });
    // no line items yet → cannot be attributed to a brand at all
    addInvoice('NO_LINES', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-05-07', total: 5000 });
    // void invoices never count, line items or not
    addInvoice('VOIDED', {
      customer: 'C1',
      rep: 'SP1',
      repName: 'Anil Mehta',
      date: '2026-05-08',
      total: 900,
      status: 'void',
      lines: [{ item_id: 'I1', name: 'Frame', item_total: 900, quantity: 1 }],
    });
  });

  test('brand amounts are the pro-rata share of the invoice total', () => {
    const out = perf.brandRollup({ months: 1, endMonth: '2026-05' });
    const byBrand = new Map(out.brands.map((b) => [b.brand_name, b.total]));

    // Battalion: 400 (WITH_LINES) + 600/1000*1180 = 708 (WITH_GST) = 1108
    // Velocity:  600 (WITH_LINES) + 400/1000*1180 = 472 (WITH_GST) = 1072
    assert.equal(byBrand.get('Battalion'), 1108);
    assert.equal(byBrand.get('Velocity'), 1072);
    assert.equal(out.total, 2180, 'brand totals reconcile to the invoice totals');
  });

  test('invoices without line items are excluded and counted for the UI banner', () => {
    const out = perf.brandRollup({ months: 1, endMonth: '2026-05' });

    assert.equal(out.pendingInvoices, 1);
    assert.equal(out.pendingAmount, 5000);
    assert.deepEqual(out.pendingByMonth, [{ month: '2026-05', count: 1, amount: 5000 }]);
    assert.equal(out.total, 2180, 'the 5000 invoice is NOT in the brand totals');

    // ...while the rep summary, which uses invoice totals, does include it
    const sum = perf.summary('2026-05');
    assert.equal(sum.totals.sales, 1000 + 1180 + 5000);
    assert.equal(sum.pendingInvoices, 1);
  });

  test('once the line items arrive the invoice joins the rollup and the count drops', () => {
    getDb()
      .prepare(
        `INSERT INTO invoice_line_items (zoho_line_item_id, invoice_id, item_id, line_order, name, quantity, rate, item_total)
         VALUES ('NO_LINES-L1', 'NO_LINES', 'I1', 0, 'Frame', 1, 5000, 5000)`
      )
      .run();

    const out = perf.brandRollup({ months: 1, endMonth: '2026-05' });
    const byBrand = new Map(out.brands.map((b) => [b.brand_name, b.total]));
    assert.equal(out.pendingInvoices, 0);
    assert.equal(byBrand.get('Battalion'), 6108);
    assert.equal(out.total, 7180);
  });

  test('items with no brand land in an explicit "Unmapped" bucket', () => {
    addItem('I3', { name: 'Mystery', sku: 'WID-1', category: 'Misc' });
    addInvoice('UNMAPPED', {
      customer: 'C1',
      rep: 'SP1',
      repName: 'Anil Mehta',
      date: '2026-05-09',
      total: 300,
      lines: [{ item_id: 'I3', name: 'Mystery', item_total: 300, quantity: 1 }],
    });

    const out = perf.brandRollup({ months: 1, endMonth: '2026-05' });
    const unmapped = out.brands.find((b) => b.brand_id === null);
    assert.ok(unmapped, 'expected an Unmapped bucket');
    assert.equal(unmapped.brand_name, 'Unmapped');
    assert.equal(unmapped.total, 300);
  });

  test('the per-rep summary carries the same brand split', () => {
    const out = perf.summary('2026-05');
    const sp1 = out.rows.find((r) => r.rep_id === 'SP1');
    const byBrand = new Map(sp1.brands.map((b) => [b.brand_name, b.sales]));
    assert.equal(byBrand.get('Battalion'), 1108);
    assert.equal(byBrand.get('Velocity'), 1072);
  });

  test('mom filtered by brand uses line-item amounts', () => {
    const out = perf.mom({ months: 1, endMonth: '2026-05', brand: B1 });
    assert.equal(out.series[0].points[0].amount, 1108);
    assert.equal(out.pendingInvoices, 1);
  });

  test('products drills down to item level', () => {
    const out = perf.products({ month: '2026-05' });
    const byItem = new Map(out.rows.map((r) => [r.item_id, r]));

    assert.equal(byItem.get('I1').quantity, 5, '2 + 3');
    assert.equal(byItem.get('I1').revenue, 1108);
    assert.equal(byItem.get('I1').brand_name, 'Battalion');
    assert.equal(byItem.get('I1').invoice_count, 2);
    assert.equal(out.pendingInvoices, 1);

    const filtered = perf.products({ month: '2026-05', brand: B2 });
    assert.equal(filtered.rows.length, 1);
    assert.equal(filtered.rows[0].item_id, 'I2');
    assert.equal(filtered.rows[0].revenue, 1072);
  });
});

// ===========================================================================
// targets
// ===========================================================================

describe('performance: targets grid', () => {
  let B1;

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addRep('SP2', 'Priya Nair');
    B1 = addBrand('Battalion', 1);
  });

  const count = () => getDb().prepare('SELECT COUNT(*) AS n FROM targets').get().n;

  test('bulk upsert is idempotent — the same payload twice leaves one row each', () => {
    const cells = [
      { salesperson_id: 'SP1', brand_id: null, target_amount: 900000 },
      { salesperson_id: 'SP1', brand_id: B1, target_amount: 400000 },
      { salesperson_id: 'SP2', brand_id: null, target_amount: 750000 },
    ];

    perf.upsertTargets('2026-05', cells);
    assert.equal(count(), 3);

    const second = perf.upsertTargets('2026-05', cells);
    assert.equal(count(), 3);
    assert.equal(second.upserted, 3);

    const row = getDb()
      .prepare('SELECT target_amount FROM targets WHERE salesperson_id = ? AND month = ? AND brand_id IS NULL')
      .get('SP1', '2026-05');
    assert.equal(row.target_amount, 900000);
  });

  test('the overall row and a brand row for the same rep are separate cells', () => {
    perf.upsertTargets('2026-05', [
      { salesperson_id: 'SP1', brand_id: null, target_amount: 100 },
      { salesperson_id: 'SP1', brand_id: B1, target_amount: 200 },
    ]);
    assert.equal(count(), 2);
  });

  test('re-saving with a new amount updates in place', () => {
    perf.upsertTargets('2026-05', [{ salesperson_id: 'SP1', brand_id: null, target_amount: 100 }]);
    perf.upsertTargets('2026-05', [{ salesperson_id: 'SP1', brand_id: null, target_amount: 250 }]);
    assert.equal(count(), 1);
    assert.equal(perf.getTargets('2026-05').rows[0].target_amount, 250);
  });

  test('clearing a cell to zero deletes the row', () => {
    perf.upsertTargets('2026-05', [{ salesperson_id: 'SP1', brand_id: null, target_amount: 100 }]);
    const out = perf.upsertTargets('2026-05', [{ salesperson_id: 'SP1', brand_id: null, target_amount: 0 }]);
    assert.equal(count(), 0);
    assert.equal(out.removed, 1);
  });

  test('targets are scoped to their month', () => {
    perf.upsertTargets('2026-05', [{ salesperson_id: 'SP1', brand_id: null, target_amount: 100 }]);
    perf.upsertTargets('2026-06', [{ salesperson_id: 'SP1', brand_id: null, target_amount: 200 }]);
    assert.equal(count(), 2);
    assert.equal(perf.getTargets('2026-05').rows[0].target_amount, 100);
    assert.equal(perf.getTargets('2026-06').rows[0].target_amount, 200);
  });

  test('the grid lists every rep and active brand, with sales alongside', () => {
    addCustomer('C1', 'Sharma Cycle Mart');
    addInvoice('T1', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-05-05', total: 1234 });
    const grid = perf.getTargets('2026-05');

    assert.deepEqual(grid.reps.map((r) => r.id).sort(), ['SP1', 'SP2']);
    assert.deepEqual(grid.brands.map((b) => b.name), ['Battalion']);
    assert.equal(grid.reps.find((r) => r.id === 'SP1').sales, 1234);
  });
});

// ===========================================================================
// month helpers
// ===========================================================================

describe('performance: month helpers', () => {
  test('monthList walks backwards across a year boundary', () => {
    assert.deepEqual(perf.monthList('2026-02', 4), ['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  test('shiftMonth handles both directions', () => {
    assert.equal(perf.shiftMonth('2026-01', -1), '2025-12');
    assert.equal(perf.shiftMonth('2026-12', 1), '2027-01');
  });
});
