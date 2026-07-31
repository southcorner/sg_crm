'use strict';

/**
 * Phase 3 unit tests — dormant customers, the cheque register (incl. the
 * reminder-engine helper) and monthly focus plans.
 *
 * Same shape as phase2.test.js: a throwaway SQLite file, rows inserted by hand,
 * every expectation computed on paper. `now` is injected everywhere a date
 * boundary matters so the suite gives the same answer on any calendar day.
 *   npm test --workspace=server
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

// point config at a scratch database BEFORE anything requires it
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcrm-p3-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DATA_DIR = TMP_DIR;
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const config = require('../src/config');
const attribution = require('../src/services/attribution');
const dormant = require('../src/services/dormant');
const cheques = require('../src/services/cheques');
const focus = require('../src/services/focus');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const TABLES = [
  'cheques',
  'focus_plans',
  'customer_rep_assignments',
  'invoice_line_items',
  'payments',
  'invoices',
  'customers',
  'salespersons',
];

function resetDb() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('cheques','focus_plans','customer_rep_assignments')");
  db.exec('PRAGMA foreign_keys = ON');
}

function addRep(id, name) {
  getDb().prepare('INSERT INTO salespersons (zoho_salesperson_id, name, is_active) VALUES (?, ?, 1)').run(id, name);
  return id;
}

function addCustomer(id, name, { status = 'active', outstanding = 0 } = {}) {
  getDb()
    .prepare('INSERT INTO customers (zoho_contact_id, contact_name, status, outstanding_receivable) VALUES (?, ?, ?, ?)')
    .run(id, name, status, outstanding);
  return id;
}

function addInvoice(id, { customer, rep = null, repName = null, date, total = 1000, status = 'sent' }) {
  getDb()
    .prepare(
      `INSERT INTO invoices (zoho_invoice_id, invoice_number, customer_id, customer_name,
         salesperson_id, salesperson_name, invoice_date, due_date, status, total, sub_total, balance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(id, id, customer, customer, rep, repName, date, date, status, total, total);
  return id;
}

const AT = (iso) => new Date(`${iso}T10:00:00`);

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
  // every test starts from the shipped defaults, whatever the settings test did
  config.setSetting('dormant_months', 3);
  config.setSetting('cheque_lead_days', 3);
});

// ===========================================================================
// dormant customers
// ===========================================================================

describe('dormant: the threshold boundary', () => {
  const NOW = AT('2026-07-15'); // → 3-month threshold is 2026-04-15

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addCustomer('EXACT', 'Exactly Three Months', { outstanding: 100 });
    addCustomer('DAYOVER', 'Three Months And A Day', { outstanding: 200 });
    addCustomer('RECENT', 'Bought Last Week', { outstanding: 300 });
    addInvoice('I-EXACT', { customer: 'EXACT', rep: 'SP1', date: '2026-04-15' });
    addInvoice('I-DAYOVER', { customer: 'DAYOVER', rep: 'SP1', date: '2026-04-14' });
    addInvoice('I-RECENT', { customer: 'RECENT', rep: 'SP1', date: '2026-07-08' });
  });

  const idsAt = (opts = {}) => dormant.listDormant({ now: NOW, ...opts }).rows.map((r) => r.id).sort();

  test('the threshold is exactly today minus N months', () => {
    assert.equal(dormant.thresholdDate(3, { now: NOW }), '2026-04-15');
    assert.equal(dormant.listDormant({ now: NOW }).threshold, '2026-04-15');
  });

  test('a last invoice exactly N months old is NOT dormant; one day older is', () => {
    assert.deepEqual(idsAt(), ['DAYOVER']);
  });

  test('the window override beats the setting, and the response says which was used', () => {
    const out = dormant.listDormant({ months: 4, now: NOW });
    assert.equal(out.months, 4);
    assert.equal(out.threshold, '2026-03-15');
    assert.deepEqual(out.rows.map((r) => r.id), []);

    const wide = dormant.listDormant({ months: 1, now: NOW });
    assert.equal(wide.threshold, '2026-06-15');
    assert.deepEqual(wide.rows.map((r) => r.id).sort(), ['DAYOVER', 'EXACT']);
  });

  test('the setting drives the default window', () => {
    config.setSetting('dormant_months', 1);
    assert.deepEqual(idsAt(), ['DAYOVER', 'EXACT']);
  });

  test('months_dormant counts whole months only', () => {
    const row = dormant.listDormant({ now: NOW }).rows[0];
    assert.equal(row.id, 'DAYOVER');
    assert.equal(row.months_dormant, 3, '14 Apr → 15 Jul is three whole months');
    assert.equal(dormant.monthsBetween('2026-04-16', '2026-07-15'), 2, 'not yet three');
  });
});

describe('dormant: who is in the list at all', () => {
  const NOW = AT('2026-07-15');

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addRep('SP2', 'Priya Nair');
    addCustomer('OLD', 'Long Gone Traders', { outstanding: 5000 });
    addCustomer('DEAD', 'Closed Account', { status: 'inactive', outstanding: 900 });
    addCustomer('NEVER', 'Never Bought Anything');
    addCustomer('VOIDONLY', 'Only Void Invoices');
    addCustomer('VOIDLATEST', 'Latest Invoice Was Voided');

    addInvoice('I-OLD', { customer: 'OLD', rep: 'SP1', repName: 'Anil Mehta', date: '2026-01-10' });
    addInvoice('I-DEAD', { customer: 'DEAD', rep: 'SP1', date: '2026-01-11' });
    addInvoice('I-VOID', { customer: 'VOIDONLY', rep: 'SP1', date: '2026-01-12', status: 'void' });
    addInvoice('I-VL-OLD', { customer: 'VOIDLATEST', rep: 'SP1', date: '2026-01-13' });
    addInvoice('I-VL-NEW', { customer: 'VOIDLATEST', rep: 'SP1', date: '2026-07-01', status: 'void' });
  });

  const ids = (opts) => dormant.listDormant({ now: NOW, ...opts }).rows.map((r) => r.id).sort();

  test('a customer that never bought is not "dormant", it is a prospect', () => {
    assert.equal(ids().includes('NEVER'), false);
  });

  test('void invoices do not count as activity, in either direction', () => {
    assert.equal(ids().includes('VOIDONLY'), false, 'void-only customers stay out of the list');
    assert.equal(ids().includes('VOIDLATEST'), true, 'a voided recent invoice does not keep a customer awake');
  });

  test('inactive customers are hidden unless asked for', () => {
    assert.deepEqual(ids(), ['OLD', 'VOIDLATEST']);
    assert.deepEqual(ids({ includeInactive: true }), ['DEAD', 'OLD', 'VOIDLATEST']);
  });

  test('rows carry the effective rep, outstanding and last invoice date', () => {
    const row = dormant.listDormant({ now: NOW }).rows.find((r) => r.id === 'OLD');
    assert.equal(row.effective_rep_id, 'SP1');
    assert.equal(row.effective_rep_name, 'Anil Mehta');
    assert.equal(row.outstanding_receivable, 5000);
    assert.equal(row.last_invoice_date, '2026-01-10');
    assert.equal(row.in_focus, false);
  });

  test('a reassignment moves the row to the new rep', () => {
    attribution.assignCustomer('OLD', 'SP2', 'all_history', null, { now: NOW });
    const row = dormant.listDormant({ now: NOW }).rows.find((r) => r.id === 'OLD');
    assert.equal(row.effective_rep_id, 'SP2');
    assert.equal(row.effective_rep_name, 'Priya Nair');
  });

  test('dormantCount agrees with the list it summarizes', () => {
    const list = dormant.listDormant({ now: NOW });
    const count = dormant.dormantCount({ now: NOW });
    assert.equal(count.count, list.rows.length);
    assert.equal(count.threshold, list.threshold);
    assert.equal(count.outstanding, list.outstandingTotal);
  });
});

// ===========================================================================
// cheques
// ===========================================================================

describe('cheques: chequesDueInDays', () => {
  const NOW = AT('2026-07-15');
  const day = (n) => cheques.addDays('2026-07-15', n);

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addCustomer('C1', 'Sharma Cycle Mart');
    addCustomer('C2', 'Velocity Bikes');
    addInvoice('I1', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-07-01' });

    const make = (customer, days, status, number, amount = 1000) => {
      const row = cheques.createCheque(
        { customer_id: customer, amount, cheque_number: number, deposit_date: day(days), bank_name: 'HDFC' },
        { now: NOW }
      );
      if (status !== 'pending') cheques.updateCheque(row.id, { status }, { now: NOW });
      return row.id;
    };

    make('C1', 0, 'pending', 'TODAY-1');
    make('C2', 0, 'pending', 'TODAY-2');
    make('C1', 3, 'pending', 'D3');
    make('C1', 7, 'pending', 'D7');
    make('C2', 4, 'pending', 'D4');
    make('C1', -2, 'pending', 'PAST'); // already due, never deposited
    // same dates, settled statuses — none of these may ever come back
    make('C2', 0, 'deposited', 'X-TODAY');
    make('C1', 3, 'deposited', 'X-D3');
    make('C2', 3, 'cleared', 'X-D3B');
    make('C1', 7, 'bounced', 'X-D7');
  });

  const dueNumbers = (n) => cheques.chequesDueInDays(n, { now: NOW }).map((c) => c.cheque_number).sort();

  test('X = 0 returns exactly the pending cheques depositing today', () => {
    assert.deepEqual(dueNumbers(0), ['TODAY-1', 'TODAY-2']);
  });

  test('X = 3 returns exactly the pending cheques three days out', () => {
    assert.deepEqual(dueNumbers(3), ['D3']);
  });

  test('X = 7 returns exactly the pending cheques seven days out', () => {
    assert.deepEqual(dueNumbers(7), ['D7']);
  });

  test('it is an exact date match, not a window — nothing in between leaks in', () => {
    assert.deepEqual(dueNumbers(1), []);
    assert.deepEqual(dueNumbers(2), []);
    assert.deepEqual(dueNumbers(4), ['D4']);
    assert.deepEqual(dueNumbers(5), []);
  });

  test('deposited, cleared and bounced cheques are never due', () => {
    for (const n of [0, 3, 7]) {
      const statuses = cheques.chequesDueInDays(n, { now: NOW }).map((c) => c.status);
      assert.deepEqual([...new Set(statuses)], ['pending'], `only pending cheques at +${n}`);
    }
  });

  test('a due cheque carries what the reminder needs: customer and rep', () => {
    const [row] = cheques.chequesDueInDays(3, { now: NOW });
    assert.equal(row.customer_name, 'Sharma Cycle Mart');
    assert.equal(row.rep_id, 'SP1');
    assert.equal(row.rep_name, 'Anil Mehta');
    assert.equal(row.days_to_deposit, 3);
  });

  test('marking a cheque deposited takes it out of the due list immediately', () => {
    const [row] = cheques.chequesDueInDays(3, { now: NOW });
    cheques.updateCheque(row.id, { status: 'deposited' }, { now: NOW });
    assert.deepEqual(dueNumbers(3), []);
  });
});

describe('cheques: register CRUD and filters', () => {
  const NOW = AT('2026-07-15');
  const day = (n) => cheques.addDays('2026-07-15', n);

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addRep('SP2', 'Priya Nair');
    addCustomer('C1', 'Sharma Cycle Mart');
    addCustomer('C2', 'Velocity Bikes');
    addInvoice('I1', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-07-01' });
    addInvoice('I2', { customer: 'C2', rep: 'SP2', repName: 'Priya Nair', date: '2026-07-02' });
  });

  test('a new cheque is stamped with the customer\'s effective rep and defaults to pending', () => {
    const row = cheques.createCheque(
      { customer_id: 'C1', amount: 5000, cheque_number: '11', deposit_date: day(2), received_date: day(-1) },
      { now: NOW }
    );
    assert.equal(row.status, 'pending');
    assert.equal(row.rep_id, 'SP1');
    assert.equal(row.received_date, day(-1));
    assert.equal(row.cheque_date, day(-1), 'received_date is the cheque_date column');
    assert.equal(row.days_to_deposit, 2);
  });

  test('the stamped rep follows a reassignment made before the cheque is entered', () => {
    attribution.assignCustomer('C1', 'SP2', 'from_today', null, { now: NOW });
    const row = cheques.createCheque({ customer_id: 'C1', amount: 1, deposit_date: day(1) }, { now: NOW });
    assert.equal(row.rep_id, 'SP2');
  });

  test('an unknown customer is a 404, not a foreign-key crash', () => {
    assert.throws(
      () => cheques.createCheque({ customer_id: 'NOPE', amount: 1, deposit_date: day(1) }),
      (err) => err.status === 404 && /customer not found/.test(err.message)
    );
  });

  test('status transitions and edits round-trip', () => {
    const row = cheques.createCheque({ customer_id: 'C1', amount: 5000, deposit_date: day(2) }, { now: NOW });

    const deposited = cheques.updateCheque(row.id, { status: 'deposited' }, { now: NOW });
    assert.equal(deposited.status, 'deposited');

    const cleared = cheques.updateCheque(
      row.id,
      { status: 'cleared', amount: 5500, note: 'cleared next day', zoho_payment_id: null },
      { now: NOW }
    );
    assert.equal(cleared.status, 'cleared');
    assert.equal(cleared.amount, 5500);
    assert.equal(cleared.note, 'cleared next day');
    assert.equal(cleared.cheque_number, null, 'untouched fields stay untouched');
  });

  test('an unknown status is rejected and an unknown id is a 404', () => {
    const row = cheques.createCheque({ customer_id: 'C1', amount: 1, deposit_date: day(1) }, { now: NOW });
    assert.throws(() => cheques.updateCheque(row.id, { status: 'sideways' }), /status must be one of/);
    assert.throws(() => cheques.updateCheque(999999, { status: 'cleared' }), (e) => e.status === 404);
    assert.throws(() => cheques.deleteCheque(999999), (e) => e.status === 404);
  });

  test('filters compose: status, customer and the due-date range', () => {
    const mk = (customer, days, status) => {
      const r = cheques.createCheque({ customer_id: customer, amount: 100, deposit_date: day(days) }, { now: NOW });
      if (status !== 'pending') cheques.updateCheque(r.id, { status }, { now: NOW });
      return r.id;
    };
    mk('C1', -5, 'pending');
    mk('C1', 2, 'pending');
    mk('C1', 9, 'bounced');
    mk('C2', 2, 'pending');
    mk('C2', 20, 'cleared');

    const all = cheques.listCheques({ now: NOW });
    assert.equal(all.rows.length, 5);
    assert.equal(all.totals.amount, 500);
    assert.deepEqual(all.statusCounts, { pending: 3, deposited: 0, cleared: 1, bounced: 1 });

    assert.equal(cheques.listCheques({ status: ['pending'], now: NOW }).rows.length, 3);
    assert.equal(cheques.listCheques({ status: ['cleared', 'bounced'], now: NOW }).rows.length, 2);
    assert.equal(cheques.listCheques({ customer: 'C2', now: NOW }).rows.length, 2);
    assert.equal(
      cheques.listCheques({ dueAfter: day(0), dueBefore: day(10), now: NOW }).rows.length,
      3,
      'today..+10 covers the two +2s and the +9'
    );
    assert.equal(
      cheques.listCheques({ status: ['pending'], dueAfter: day(0), dueBefore: day(10), now: NOW }).rows.length,
      2
    );
    assert.equal(cheques.listCheques({ status: ['nonsense'], now: NOW }).rows.length, 5, 'a junk status is ignored');
  });

  test('the list is ordered by deposit date, soonest first', () => {
    cheques.createCheque({ customer_id: 'C1', amount: 1, deposit_date: day(9) }, { now: NOW });
    cheques.createCheque({ customer_id: 'C1', amount: 1, deposit_date: day(-3) }, { now: NOW });
    cheques.createCheque({ customer_id: 'C1', amount: 1, deposit_date: day(1) }, { now: NOW });
    const dates = cheques.listCheques({ now: NOW }).rows.map((r) => r.deposit_date);
    assert.deepEqual(dates, [day(-3), day(1), day(9)]);
  });

  test('the dashboard summary counts pending volume, the next 7 days and what is late', () => {
    const mk = (days, amount, status = 'pending') => {
      const r = cheques.createCheque({ customer_id: 'C1', amount, deposit_date: day(days) }, { now: NOW });
      if (status !== 'pending') cheques.updateCheque(r.id, { status }, { now: NOW });
    };
    mk(-4, 1000); // pending but already past its deposit date
    mk(0, 2000);
    mk(3, 3000);
    mk(7, 4000);
    mk(8, 5000); // outside the 7-day horizon
    mk(1, 9999, 'cleared'); // settled — not pending at all

    const s = cheques.chequeSummary({ now: NOW });
    assert.deepEqual(s.pending, { count: 5, amount: 15000 });
    assert.equal(s.next7.count, 3);
    assert.equal(s.next7.amount, 9000);
    assert.deepEqual(s.pastDue, { count: 1, amount: 1000 });
    assert.equal(s.leadDays, 3);
  });
});

// ===========================================================================
// focus plans
// ===========================================================================

describe('focus: plan CRUD', () => {
  const NOW = AT('2026-07-15');

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addRep('SP2', 'Priya Nair');
    addCustomer('C1', 'Sharma Cycle Mart', { outstanding: 4200 });
    addCustomer('C2', 'Velocity Bikes', { outstanding: 100 });
    addInvoice('I1', { customer: 'C1', rep: 'SP1', repName: 'Anil Mehta', date: '2026-06-20' });
    addInvoice('I2', { customer: 'C2', rep: 'SP2', repName: 'Priya Nair', date: '2026-06-21' });
  });

  test('a customer can only be on one month\'s plan once — the duplicate is a 409', () => {
    focus.createFocus({ month: '2026-07', customer_id: 'C1', note: 'first' });
    assert.throws(
      () => focus.createFocus({ month: '2026-07', customer_id: 'C1', note: 'again' }),
      (err) => {
        assert.equal(err.status, 409);
        assert.match(err.message, /already on the focus plan/);
        assert.ok(err.focus_id, 'the 409 points at the row that already exists');
        return true;
      }
    );
    assert.equal(focus.listFocus('2026-07').rows.length, 1);
  });

  test('the same customer in a different month is fine', () => {
    focus.createFocus({ month: '2026-07', customer_id: 'C1' });
    focus.createFocus({ month: '2026-08', customer_id: 'C1' });
    assert.equal(focus.listFocus('2026-07').rows.length, 1);
    assert.equal(focus.listFocus('2026-08').rows.length, 1);
  });

  test('the rep defaults to the customer\'s effective rep', () => {
    const item = focus.createFocus({ month: '2026-07', customer_id: 'C1' });
    assert.equal(item.salesperson_id, 'SP1');
    assert.equal(item.rep_name, 'Anil Mehta');
    assert.equal(item.rep_pinned, true, 'the default is stored, not resolved on read');
  });

  test('a reassignment before the row is created decides the default rep', () => {
    attribution.assignCustomer('C1', 'SP2', 'all_history', null, { now: NOW });
    const item = focus.createFocus({ month: '2026-07', customer_id: 'C1' });
    assert.equal(item.salesperson_id, 'SP2');
    assert.equal(item.rep_name, 'Priya Nair');
  });

  test('an explicit rep wins over the default, and an unknown one is rejected', () => {
    const item = focus.createFocus({ month: '2026-07', customer_id: 'C1', salesperson_id: 'SP2' });
    assert.equal(item.salesperson_id, 'SP2');
    assert.throws(
      () => focus.createFocus({ month: '2026-07', customer_id: 'C2', salesperson_id: 'GHOST' }),
      (e) => e.status === 404 && /salesperson not found/.test(e.message)
    );
  });

  test('a customer with no rep anywhere lands unattributed rather than failing', () => {
    addCustomer('C3', 'No Rep Traders');
    addInvoice('I3', { customer: 'C3', rep: 'GONE', repName: 'Somebody Else', date: '2026-06-01' });
    const item = focus.createFocus({ month: '2026-07', customer_id: 'C3' });
    assert.equal(item.salesperson_id, null);
    assert.equal(item.rep_name, null);
  });

  test('an unknown customer is a 404', () => {
    assert.throws(
      () => focus.createFocus({ month: '2026-07', customer_id: 'NOPE' }),
      (e) => e.status === 404 && /customer not found/.test(e.message)
    );
  });

  test('note, status and rep are all editable; delete removes the row', () => {
    const item = focus.createFocus({ month: '2026-07', customer_id: 'C1', note: 'call them' });
    const done = focus.updateFocus(item.id, { status: 'done', note: 'called, order placed' });
    assert.equal(done.status, 'done');
    assert.equal(done.note, 'called, order placed');

    const moved = focus.updateFocus(item.id, { salesperson_id: 'SP2' });
    assert.equal(moved.salesperson_id, 'SP2');
    assert.equal(moved.rep_name, 'Priya Nair');
    assert.equal(moved.status, 'done', 'a partial update leaves the rest alone');

    assert.throws(() => focus.updateFocus(item.id, { status: 'sideways' }), /status must be one of/);
    assert.deepEqual(focus.deleteFocus(item.id), { deleted: item.id });
    assert.equal(focus.listFocus('2026-07').rows.length, 0);
    assert.throws(() => focus.deleteFocus(item.id), (e) => e.status === 404);
  });

  test('the list carries the planning context and the open/done tallies', () => {
    const a = focus.createFocus({ month: '2026-07', customer_id: 'C1', note: 'chase' });
    focus.createFocus({ month: '2026-07', customer_id: 'C2' });
    focus.updateFocus(a.id, { status: 'done' });

    const out = focus.listFocus('2026-07');
    assert.equal(out.month, '2026-07');
    assert.deepEqual(out.counts, { total: 2, open: 1, done: 1, dropped: 0 });
    assert.equal(out.outstandingTotal, 4300);

    const row = out.rows.find((r) => r.customer_id === 'C1');
    assert.equal(row.customer_name, 'Sharma Cycle Mart');
    assert.equal(row.outstanding_receivable, 4200);
    assert.equal(row.last_invoice_date, null, 'denormalized until a sync recomputes it');
  });

  test('openFocusCount is the dashboard tile', () => {
    focus.createFocus({ month: '2026-07', customer_id: 'C1' });
    const b = focus.createFocus({ month: '2026-07', customer_id: 'C2' });
    focus.updateFocus(b.id, { status: 'done' });
    assert.deepEqual(focus.openFocusCount('2026-07'), { month: '2026-07', open: 1, total: 2 });
    assert.deepEqual(focus.openFocusCount('2026-08'), { month: '2026-08', open: 0, total: 0 });
  });

  test('the month defaults to the current one', () => {
    const item = focus.createFocus({ customer_id: 'C1' }, { now: NOW });
    assert.equal(item.month, focus.currentMonth(NOW));
  });

  test('a dormant row knows it is already on this month\'s plan', () => {
    addCustomer('OLD', 'Long Gone Traders');
    addInvoice('I-OLD', { customer: 'OLD', rep: 'SP1', date: '2026-01-10' });
    assert.equal(dormant.listDormant({ now: NOW }).rows.find((r) => r.id === 'OLD').in_focus, false);
    focus.createFocus({ month: '2026-07', customer_id: 'OLD', note: 'win back' });
    const row = dormant.listDormant({ now: NOW }).rows.find((r) => r.id === 'OLD');
    assert.equal(row.in_focus, true);
    assert.ok(row.focus_id);
  });
});

// ===========================================================================
// settings
// ===========================================================================

describe('settings: dormant_months and cheque_lead_days round-trip', () => {
  test('a written value is what the services read back', () => {
    assert.equal(config.getSetting('dormant_months'), 3, 'shipped default');
    assert.equal(config.getSetting('cheque_lead_days'), 3);

    config.setSetting('dormant_months', 6);
    config.setSetting('cheque_lead_days', 5);

    assert.equal(config.getSetting('dormant_months'), 6);
    assert.equal(config.getSetting('cheque_lead_days'), 5);
    assert.equal(dormant.dormantMonths(), 6, 'the dormant service picks the new window up');
    assert.equal(cheques.leadDays(), 5, 'so does the cheque lead time');
    assert.equal(config.getAllSettings().dormant_months, 6);

    // …and the value actually changes the query it drives
    addCustomer('C1', 'Sharma Cycle Mart');
    addInvoice('I1', { customer: 'C1', date: '2026-03-01' });
    assert.equal(dormant.listDormant({ now: AT('2026-07-15') }).rows.length, 0, '6 months back is 2026-01-15');
    config.setSetting('dormant_months', 4);
    assert.equal(dormant.listDormant({ now: AT('2026-07-15') }).rows.length, 1);
  });

  test('a junk or missing value falls back to the default rather than breaking the page', () => {
    config.setSetting('dormant_months', 'lots');
    assert.equal(dormant.dormantMonths(), dormant.DEFAULT_MONTHS);
    config.setSetting('cheque_lead_days', -4);
    assert.equal(cheques.leadDays(), 3);
    config.setSetting('dormant_months', 9999);
    assert.equal(dormant.dormantMonths(), dormant.MAX_MONTHS, 'clamped, not unbounded');
  });
});
