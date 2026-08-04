'use strict';

/**
 * Phase 4 unit tests — the reminder engine.
 *
 * Same shape as phase2/phase3: a throwaway SQLite file, rows inserted by hand,
 * every expectation worked out on paper, and `date` injected everywhere so the
 * suite answers the same on any calendar day.
 *
 * Delivery is exercised through an injected fake sender that records the
 * digests it was handed — nothing here opens a socket.
 *   npm test --workspace=server
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

// point config at a scratch database BEFORE anything requires it
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcrm-p4-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DATA_DIR = TMP_DIR;
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';
process.env.ENABLE_CRON = 'false';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const config = require('../src/config');
const engine = require('../src/services/reminders/engine');
const cronJobs = require('../src/jobs/cron');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const TABLES = [
  'reminders_log',
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
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('cheques','focus_plans','reminders_log')");
  db.exec('PRAGMA foreign_keys = ON');
}

function addRep(id, name, { email = null, notify = 1, active = 1 } = {}) {
  getDb()
    .prepare(
      'INSERT INTO salespersons (zoho_salesperson_id, name, crm_email, notify_email, is_active) VALUES (?, ?, ?, ?, ?)'
    )
    .run(id, name, email ?? `${id.toLowerCase()}@example.in`, notify, active);
  return id;
}

function addCustomer(id, name, { status = 'active', outstanding = 0 } = {}) {
  getDb()
    .prepare('INSERT INTO customers (zoho_contact_id, contact_name, status, outstanding_receivable) VALUES (?, ?, ?, ?)')
    .run(id, name, status, outstanding);
  return id;
}

function addInvoice(id, { customer, rep = null, date, due = date, total = 1000, balance = 0, status = 'sent', number = id }) {
  getDb()
    .prepare(
      `INSERT INTO invoices (zoho_invoice_id, invoice_number, customer_id, customer_name,
         salesperson_id, salesperson_name, invoice_date, due_date, status, total, sub_total, balance)
       VALUES (?, ?, ?, (SELECT contact_name FROM customers WHERE zoho_contact_id = ?), ?, NULL, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, number, customer, customer, rep, date, due, status, total, total, balance);
  return id;
}

function addCheque({ customer, rep, amount = 50000, number = '400001', deposit, status = 'pending', bank = 'HDFC Bank' }) {
  const info = getDb()
    .prepare(
      `INSERT INTO cheques (customer_id, salesperson_id, amount, cheque_number, bank_name, cheque_date, deposit_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(customer, rep, amount, number, bank, deposit, deposit, status);
  return Number(info.lastInsertRowid);
}

function addFocus({ month, customer, rep, note = null, status = 'open' }) {
  const info = getDb()
    .prepare('INSERT INTO focus_plans (month, customer_id, salesperson_id, note, status) VALUES (?, ?, ?, ?, ?)')
    .run(month, customer, rep, note, status);
  return Number(info.lastInsertRowid);
}

/** Write a reminders_log row directly — the dedupe windows read these. */
function logSent({ date, ruleType, entityType, entityId, rep, detail = null, status = 'sent' }) {
  getDb()
    .prepare(
      `INSERT INTO reminders_log (run_date, rule_type, entity_type, entity_id, salesperson_id, channel, status, detail)
       VALUES (?, ?, ?, ?, ?, 'email', ?, ?)`
    )
    .run(date, ruleType, entityType, entityId, rep, status, detail === null ? null : JSON.stringify(detail));
}

const logCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM reminders_log').get().n;
const D = engine.addDays;

/** A sender that records what it was asked to deliver. `failFor` throws. */
function fakeSender({ failFor = [] } = {}) {
  const sent = [];
  const fn = async (digest) => {
    if (failFor.includes(digest.rep.id)) throw new Error(`SMTP refused mail for ${digest.rep.id}`);
    sent.push(digest);
    return { to: digest.rep.email, messageId: `<fake-${digest.rep.id}-${digest.runDate}>` };
  };
  return { sent, senders: { email: fn } };
}

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
  config.setSetting('dormant_months', 3);
  config.setSetting('cheque_lead_days', 3);
  config.setSetting('overdue_min_days', 1);
  config.setSetting('overdue_min_amount', 0);
  config.setSetting('overdue_resend_days', 7);
  config.setSetting('digest_send_time', '09:00');
  // every rule is automatic by default; the per-rule tests narrow this
  for (const key of engine.RULE_KEYS) config.setSetting(`rule_${key}_enabled`, true);
});

// ===========================================================================
// overdue
// ===========================================================================

describe('overdue: the due-date boundary', () => {
  const RUN = '2026-08-10';

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addCustomer('C1', 'Sharma Cycle Mart');
    // rep resolution falls back to the invoice's own salesperson
    addInvoice('I-EXACT', { customer: 'C1', rep: 'SP1', date: '2026-07-01', due: '2026-08-09', balance: 5000, number: 'INV-1' });
    addInvoice('I-DAYOVER', { customer: 'C1', rep: 'SP1', date: '2026-07-01', due: '2026-08-08', balance: 7000, number: 'INV-2' });
    addInvoice('I-FUTURE', { customer: 'C1', rep: 'SP1', date: '2026-07-01', due: '2026-08-20', balance: 9000, number: 'INV-3' });
  });

  const invoiceIds = (date = RUN) =>
    engine
      .overdueRule(date, engine.settingsSnapshot())
      .groups.flatMap((g) => g.invoices.map((i) => i.invoice_id))
      .sort();

  test('an invoice due exactly at the cut-off is not chased; a day older is', () => {
    // overdue_min_days = 1 → cut-off is 2026-08-09, and the filter is `<`
    assert.equal(engine.overdueRule(RUN, engine.settingsSnapshot()).cutoff, '2026-08-09');
    assert.deepEqual(invoiceIds(), ['I-DAYOVER']);
  });

  test('raising overdue_min_days pushes the cut-off back', () => {
    config.setSetting('overdue_min_days', 5);
    assert.equal(engine.overdueRule(RUN, engine.settingsSnapshot()).cutoff, '2026-08-05');
    assert.deepEqual(invoiceIds(), []);
  });

  test('paid, void and draft invoices are never chased', () => {
    addInvoice('I-VOID', { customer: 'C1', rep: 'SP1', date: '2026-06-01', due: '2026-06-10', balance: 4000, status: 'void' });
    addInvoice('I-DRAFT', { customer: 'C1', rep: 'SP1', date: '2026-06-01', due: '2026-06-10', balance: 4000, status: 'draft' });
    addInvoice('I-PAID', { customer: 'C1', rep: 'SP1', date: '2026-06-01', due: '2026-06-10', balance: 0, status: 'paid' });
    assert.deepEqual(invoiceIds(), ['I-DAYOVER']);
  });

  test('overdue_min_amount filters out small balances', () => {
    config.setSetting('overdue_min_amount', 7500);
    assert.deepEqual(invoiceIds(), []);
    config.setSetting('overdue_min_amount', 7000);
    assert.deepEqual(invoiceIds(), ['I-DAYOVER']);
  });

  test('invoices are grouped per customer with a total and the oldest age', () => {
    addInvoice('I-OLD', { customer: 'C1', rep: 'SP1', date: '2026-05-01', due: '2026-06-10', balance: 3000, number: 'INV-9' });
    const groups = engine.overdueRule(RUN, engine.settingsSnapshot()).groups;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].customer_id, 'C1');
    assert.equal(groups[0].total, 10000); // 7000 + 3000
    assert.equal(groups[0].oldest_days_overdue, 61); // 2026-06-10 → 2026-08-10
    assert.deepEqual(groups[0].invoices.map((i) => i.invoice_number).sort(), ['INV-2', 'INV-9']);
  });
});

describe('overdue: the re-nag window', () => {
  const RUN = '2026-08-10';

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addCustomer('C1', 'Sharma Cycle Mart');
    addInvoice('I-1', { customer: 'C1', rep: 'SP1', date: '2026-06-01', due: '2026-06-30', balance: 5000, number: 'INV-1' });
  });

  const included = () =>
    engine.overdueRule(RUN, engine.settingsSnapshot()).groups.flatMap((g) => g.invoices.map((i) => i.invoice_id));

  test('never reminded → included', () => {
    assert.deepEqual(included(), ['I-1']);
  });

  test('reminded inside overdue_resend_days → suppressed', () => {
    logSent({ date: D(RUN, -6), ruleType: 'overdue', entityType: 'invoice', entityId: 'I-1', rep: 'SP1' });
    assert.deepEqual(included(), []);
    assert.equal(engine.overdueRule(RUN, engine.settingsSnapshot()).suppressed.length, 1);
  });

  test('reminded exactly overdue_resend_days ago → back in', () => {
    logSent({ date: D(RUN, -7), ruleType: 'overdue', entityType: 'invoice', entityId: 'I-1', rep: 'SP1' });
    assert.deepEqual(included(), ['I-1']);
  });

  test('a FAILED send does not start the window — it is retried', () => {
    logSent({ date: D(RUN, -1), ruleType: 'overdue', entityType: 'invoice', entityId: 'I-1', rep: 'SP1', status: 'failed' });
    assert.deepEqual(included(), ['I-1']);
  });

  test('shortening overdue_resend_days re-opens the window immediately', () => {
    logSent({ date: D(RUN, -3), ruleType: 'overdue', entityType: 'invoice', entityId: 'I-1', rep: 'SP1' });
    assert.deepEqual(included(), []);
    config.setSetting('overdue_resend_days', 2);
    assert.deepEqual(included(), ['I-1']);
  });
});

// ===========================================================================
// cheques
// ===========================================================================

describe('cheque: fires exactly once per cheque per deposit date', () => {
  const RUN = '2026-08-10'; // lead 3 → deposit date 2026-08-13
  let chequeId;

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addCustomer('C1', 'Sharma Cycle Mart');
    addInvoice('I-1', { customer: 'C1', rep: 'SP1', date: '2026-08-01', balance: 0, status: 'paid' });
    chequeId = addCheque({ customer: 'C1', rep: 'SP1', deposit: '2026-08-13', amount: 76250, number: '400003' });
    addCheque({ customer: 'C1', rep: 'SP1', deposit: '2026-08-13', amount: 31000, number: '400004', status: 'deposited' });
    addCheque({ customer: 'C1', rep: 'SP1', deposit: '2026-08-14', amount: 21000, number: '400005' });
  });

  test('only pending cheques on exactly today + lead days', () => {
    const items = engine.chequeRule(RUN, engine.settingsSnapshot()).items;
    assert.deepEqual(items.map((i) => i.cheque_number), ['400003']);
    assert.equal(items[0].amount, 76250);
    assert.equal(items[0].rep_id, 'SP1');
  });

  test('once logged for that deposit date it never fires again', () => {
    logSent({
      date: RUN,
      ruleType: 'cheque',
      entityType: 'cheque',
      entityId: String(chequeId),
      rep: 'SP1',
      detail: { deposit_date: '2026-08-13' },
    });
    const rule = engine.chequeRule(RUN, engine.settingsSnapshot());
    assert.deepEqual(rule.items, []);
    assert.equal(rule.suppressed.length, 1);
  });

  test('a rescheduled deposit date is a new event and fires again', () => {
    logSent({
      date: RUN,
      ruleType: 'cheque',
      entityType: 'cheque',
      entityId: String(chequeId),
      rep: 'SP1',
      detail: { deposit_date: '2026-08-13' },
    });
    getDb().prepare('UPDATE cheques SET deposit_date = ? WHERE id = ?').run('2026-08-20', chequeId);
    // run 3 days before the NEW date
    const items = engine.chequeRule('2026-08-17', engine.settingsSnapshot()).items;
    assert.deepEqual(items.map((i) => i.cheque_id), [chequeId]);
  });
});

// ===========================================================================
// dormant
// ===========================================================================

describe('dormant: cap, suppression window and rotation', () => {
  const RUN = '2026-08-10'; // 3-month threshold → 2026-05-10

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    // 12 dormant customers, descending outstanding so the natural order is known
    for (let i = 1; i <= 12; i += 1) {
      addCustomer(`D${i}`, `Dormant ${String(i).padStart(2, '0')}`, { outstanding: 12000 - i * 100 });
      addInvoice(`I-D${i}`, { customer: `D${i}`, rep: 'SP1', date: '2026-01-15', balance: 0, status: 'paid' });
    }
  });

  const names = (date = RUN) => engine.dormantRule(date, engine.settingsSnapshot()).eligible.map((d) => d.customer_id);

  test('every dormant customer is a candidate; the cap is applied per digest', () => {
    assert.equal(names().length, 12);
    const digest = engine.evaluate({ date: RUN }).digests[0];
    assert.equal(digest.sections.dormant.length, engine.DORMANT_MAX_PER_DIGEST);
    assert.equal(digest.sections.dormant.length, 10);
  });

  test('a customer reminded inside 14 days is held back; at 14 days it returns', () => {
    logSent({ date: D(RUN, -13), ruleType: 'dormant', entityType: 'customer', entityId: 'D1', rep: 'SP1' });
    logSent({ date: D(RUN, -14), ruleType: 'dormant', entityType: 'customer', entityId: 'D2', rep: 'SP1' });
    const eligible = names();
    assert.ok(!eligible.includes('D1'), 'D1 was reminded 13 days ago');
    assert.ok(eligible.includes('D2'), 'D2 was reminded exactly 14 days ago');
    assert.equal(engine.dormantRule(RUN, engine.settingsSnapshot()).suppressed.length, 1);
  });

  test('the list rotates: longest-unreminded first, never-reminded before all', () => {
    // remind the three richest recently enough to be ordered, not suppressed
    logSent({ date: D(RUN, -20), ruleType: 'dormant', entityType: 'customer', entityId: 'D1', rep: 'SP1' });
    logSent({ date: D(RUN, -30), ruleType: 'dormant', entityType: 'customer', entityId: 'D2', rep: 'SP1' });
    logSent({ date: D(RUN, -40), ruleType: 'dormant', entityType: 'customer', entityId: 'D3', rep: 'SP1' });

    const order = names();
    // the nine never-reminded customers come first (highest outstanding first)
    assert.deepEqual(order.slice(0, 3), ['D4', 'D5', 'D6']);
    // then the reminded ones, oldest reminder first
    assert.deepEqual(order.slice(-3), ['D3', 'D2', 'D1']);

    const digest = engine.evaluate({ date: RUN }).digests[0];
    assert.equal(digest.sections.dormant.length, 10);
    assert.ok(!digest.sections.dormant.some((d) => d.customer_id === 'D1'), 'the most-recently reminded rotates out');
  });
});

// ===========================================================================
// focus
// ===========================================================================

describe('focus: Mondays, plus a catch-up the first time each month', () => {
  const MONDAY = '2026-08-03';
  const TUESDAY = '2026-08-04';

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addCustomer('C1', 'Sharma Cycle Mart');
    addInvoice('I-1', { customer: 'C1', rep: 'SP1', date: '2026-08-01', balance: 0, status: 'paid' });
    addFocus({ month: '2026-08', customer: 'C1', rep: 'SP1', note: 'Push the new frame range' });
  });

  test('the fixture dates really are a Monday and a Tuesday', () => {
    assert.equal(new Date(`${MONDAY}T12:00:00`).getDay(), 1);
    assert.equal(new Date(`${TUESDAY}T12:00:00`).getDay(), 2);
  });

  test('Monday always includes the focus section', () => {
    logSent({ date: '2026-08-01', ruleType: 'focus', entityType: 'focus_plan', entityId: '1', rep: 'SP1' });
    assert.ok(engine.focusRule(MONDAY).included.has('SP1'));
  });

  test('mid-week it is included only when the rep has not seen it this month', () => {
    assert.ok(engine.focusRule(TUESDAY).included.has('SP1'), 'never sent this month → catch-up');
    logSent({ date: '2026-08-03', ruleType: 'focus', entityType: 'focus_plan', entityId: '1', rep: 'SP1' });
    const rule = engine.focusRule(TUESDAY);
    assert.ok(!rule.included.has('SP1'));
    assert.equal(rule.suppressed[0].reason, 'weekly_cadence');
  });

  test('last month’s send does not suppress this month', () => {
    logSent({ date: '2026-07-28', ruleType: 'focus', entityType: 'focus_plan', entityId: '1', rep: 'SP1' });
    assert.ok(engine.focusRule(TUESDAY).included.has('SP1'));
  });

  test('closed focus rows are not chased', () => {
    getDb().prepare("UPDATE focus_plans SET status = 'done'").run();
    assert.ok(!engine.focusRule(MONDAY).included.has('SP1'));
  });
});

// ===========================================================================
// digest composition
// ===========================================================================

describe('digest composition', () => {
  const RUN = '2026-08-04'; // a Tuesday

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addRep('SP2', 'Priya Nair');
    addRep('SP3', 'Rahul Desai');

    // SP1: overdue + a cheque + a focus row
    addCustomer('C1', 'Sharma Cycle Mart', { outstanding: 12000 });
    addInvoice('I-1', { customer: 'C1', rep: 'SP1', date: '2026-06-01', due: '2026-06-20', balance: 12000, number: 'INV-1' });
    addCheque({ customer: 'C1', rep: 'SP1', deposit: '2026-08-07', amount: 50000, number: '400001' });
    addFocus({ month: '2026-08', customer: 'C1', rep: 'SP1', note: 'Reorder due' });

    // SP2: one dormant customer only
    addCustomer('C2', 'Frontier Sports', { outstanding: 0 });
    addInvoice('I-2', { customer: 'C2', rep: 'SP2', date: '2026-01-05', balance: 0, status: 'paid', number: 'INV-2' });

    // SP3: a customer, fully paid and recent — nothing to say
    addCustomer('C3', 'Velocity Bikes', { outstanding: 0 });
    addInvoice('I-3', { customer: 'C3', rep: 'SP3', date: '2026-08-01', balance: 0, status: 'paid', number: 'INV-3' });
  });

  test('one digest per rep, and reps with nothing to say get none', () => {
    const { digests } = engine.evaluate({ date: RUN });
    assert.deepEqual(digests.map((d) => d.rep.id), ['SP1', 'SP2']);
  });

  test('each section lands under the right rep', () => {
    const byRep = new Map(engine.evaluate({ date: RUN }).digests.map((d) => [d.rep.id, d]));

    const one = byRep.get('SP1');
    assert.equal(one.sections.overdue.length, 1);
    assert.equal(one.sections.overdue[0].total, 12000);
    assert.equal(one.sections.cheques.length, 1);
    assert.equal(one.sections.focus.length, 1);
    assert.equal(one.sections.dormant.length, 0);
    assert.equal(one.counts.overdueAmount, 12000);

    const two = byRep.get('SP2');
    assert.equal(two.sections.dormant.length, 1);
    assert.equal(two.sections.dormant[0].customer_id, 'C2');
    assert.equal(two.sections.overdue.length, 0);
  });

  test('both renderings carry the section contents', () => {
    const digest = engine.evaluate({ date: RUN, rep: 'SP1' }).digests[0];
    for (const body of [digest.text, digest.html]) {
      assert.match(body, /Sharma Cycle Mart/);
      assert.match(body, /INV-1/);
      assert.match(body, /400001/);
      assert.match(body, /Reorder due/);
    }
    assert.match(digest.text, /⚠ OVERDUE/);
    assert.match(digest.text, /🏦 CHEQUES DUE/);
    assert.match(digest.html, /<table/);
    assert.match(digest.html, /style="/);
    assert.match(digest.subject, /SG CRM digest/);
  });

  test('html is escaped', () => {
    getDb().prepare("UPDATE customers SET contact_name = '<script>x</script>' WHERE zoho_contact_id = 'C1'").run();
    const digest = engine.evaluate({ date: RUN, rep: 'SP1' }).digests[0];
    assert.ok(!digest.html.includes('<script>'));
    assert.match(digest.html, /&lt;script&gt;/);
  });

  test('inactive reps are never evaluated', () => {
    getDb().prepare("UPDATE salespersons SET is_active = 0 WHERE zoho_salesperson_id = 'SP1'").run();
    const { digests } = engine.evaluate({ date: RUN });
    assert.deepEqual(digests.map((d) => d.rep.id), ['SP2']);
  });

  test('notify_email off leaves the rep with no channel', () => {
    getDb().prepare("UPDATE salespersons SET notify_email = 0 WHERE zoho_salesperson_id = 'SP1'").run();
    const digest = engine.evaluate({ date: RUN, rep: 'SP1' }).digests[0];
    assert.deepEqual(digest.rep.channels, []);
  });

  test('crm_email wins over the Zoho address', () => {
    getDb()
      .prepare("UPDATE salespersons SET email = 'zoho@x.in', crm_email = 'crm@x.in' WHERE zoho_salesperson_id = 'SP1'")
      .run();
    const digest = engine.evaluate({ date: RUN, rep: 'SP1' }).digests[0];
    assert.equal(digest.rep.email, 'crm@x.in');
    assert.equal(digest.rep.email_source, 'crm_email');
  });

  test('evaluate() writes nothing', () => {
    const before = logCount();
    engine.evaluate({ date: RUN });
    engine.evaluate({ date: RUN });
    assert.equal(logCount(), before);
  });
});

// ===========================================================================
// run(): delivery, logging, dedupe
// ===========================================================================

describe('run(): delivery and the crash-safe dedupe row', () => {
  const RUN = '2026-08-04';

  beforeEach(() => {
    addRep('SP1', 'Anil Mehta');
    addRep('SP2', 'Priya Nair');
    addCustomer('C1', 'Sharma Cycle Mart', { outstanding: 12000 });
    addInvoice('I-1', { customer: 'C1', rep: 'SP1', date: '2026-06-01', due: '2026-06-20', balance: 12000, number: 'INV-1' });
    addCustomer('C2', 'Frontier Sports', { outstanding: 4000 });
    addInvoice('I-2', { customer: 'C2', rep: 'SP2', date: '2026-06-01', due: '2026-06-20', balance: 4000, number: 'INV-2' });
  });

  test('one email per rep, and every item is logged with its channel', async () => {
    const fake = fakeSender();
    const result = await engine.run({ date: RUN, senders: fake.senders });

    assert.equal(fake.sent.length, 2);
    assert.deepEqual(result.results.map((r) => r.status), ['sent', 'sent']);
    assert.deepEqual(fake.sent.map((d) => d.rep.email).sort(), ['sp1@example.in', 'sp2@example.in']);

    const rows = getDb().prepare('SELECT rule_type, status, channel FROM reminders_log ORDER BY id').all();
    assert.equal(rows.filter((r) => r.rule_type === 'digest' && r.status === 'sent').length, 2);
    assert.equal(rows.filter((r) => r.rule_type === 'overdue' && r.status === 'sent').length, 2);
    assert.ok(rows.every((r) => r.channel === 'email'));
  });

  test('a second run the same day sends nothing', async () => {
    const first = fakeSender();
    await engine.run({ date: RUN, senders: first.senders });
    assert.equal(first.sent.length, 2);

    // the item-level windows alone already empty the digest…
    const second = fakeSender();
    const result = await engine.run({ date: RUN, senders: second.senders });
    assert.equal(second.sent.length, 0);
    assert.deepEqual(result.digests, []);
  });

  test('the digest row alone stops a re-send when the item rows are lost', async () => {
    const first = fakeSender();
    await engine.run({ date: RUN, senders: first.senders });
    assert.equal(first.sent.length, 2);

    // crash right after the digest rows were written: no item rows survived,
    // so every rule would happily re-include its items. Only the per-rep/day
    // `digest` row stands between the rep and a duplicate email.
    getDb().prepare("DELETE FROM reminders_log WHERE rule_type <> 'digest'").run();

    const second = fakeSender();
    const result = await engine.run({ date: RUN, senders: second.senders });
    assert.equal(result.digests.length, 2, 'the rules did re-compose both digests');
    assert.equal(second.sent.length, 0, 'but nothing was sent');
    assert.deepEqual(result.results.map((r) => r.status), ['skipped_dedupe', 'skipped_dedupe']);
  });

  test('a pending digest row (crashed mid-send) also blocks a re-send', async () => {
    // simulate: the row was written, the process died before the mail went out
    logSent({ date: RUN, ruleType: 'digest', entityType: null, entityId: null, rep: 'SP1', status: 'pending' });
    const fake = fakeSender();
    const result = await engine.run({ date: RUN, senders: fake.senders });
    assert.deepEqual(fake.sent.map((d) => d.rep.id), ['SP2']);
    assert.equal(result.results.find((r) => r.rep.id === 'SP1').status, 'skipped_dedupe');
  });

  test('the next day starts clean', async () => {
    await engine.run({ date: RUN, senders: fakeSender().senders });
    // the overdue resend window still holds the invoice back the next morning…
    const nextDay = fakeSender();
    await engine.run({ date: D(RUN, 1), senders: nextDay.senders });
    assert.equal(nextDay.sent.length, 0, 'nothing new to say → no digest at all');
    // …and lets it through once overdue_resend_days have passed
    const later = fakeSender();
    await engine.run({ date: D(RUN, 7), senders: later.senders });
    assert.equal(later.sent.length, 2);
  });

  test('dry_run has zero side effects', async () => {
    const before = logCount();
    const fake = fakeSender();
    const result = await engine.run({ date: RUN, dryRun: true, senders: fake.senders });

    assert.equal(logCount(), before);
    assert.equal(fake.sent.length, 0);
    assert.equal(result.dryRun, true);
    assert.equal(result.digests.length, 2);
    assert.deepEqual(result.results.map((r) => r.status), ['would_send', 'would_send']);
    assert.deepEqual(result.results.map((r) => r.wouldDedupe), [false, false]);
  });

  test('dry_run reports when the real run would be deduped', async () => {
    await engine.run({ date: RUN, senders: fakeSender().senders });
    getDb().prepare("DELETE FROM reminders_log WHERE rule_type <> 'digest'").run();
    const result = await engine.run({ date: RUN, dryRun: true, senders: fakeSender().senders });
    assert.equal(result.digests.length, 2);
    assert.deepEqual(result.results.map((r) => r.wouldDedupe), [true, true]);
  });

  test('a rep with no channel is skipped, not sent to', async () => {
    getDb().prepare("UPDATE salespersons SET notify_email = 0 WHERE zoho_salesperson_id = 'SP1'").run();
    const fake = fakeSender();
    const result = await engine.run({ date: RUN, senders: fake.senders });
    assert.deepEqual(fake.sent.map((d) => d.rep.id), ['SP2']);
    assert.equal(result.results.find((r) => r.rep.id === 'SP1').status, 'skipped');
  });

  test('a send failure is recorded and the engine carries on to the next rep', async () => {
    const fake = fakeSender({ failFor: ['SP1'] });
    const result = await engine.run({ date: RUN, senders: fake.senders });

    assert.deepEqual(fake.sent.map((d) => d.rep.id), ['SP2'], 'SP2 still got their digest');
    assert.equal(result.results.find((r) => r.rep.id === 'SP1').status, 'failed');
    assert.equal(result.results.find((r) => r.rep.id === 'SP2').status, 'sent');

    const failed = getDb()
      .prepare("SELECT rule_type, detail FROM reminders_log WHERE salesperson_id = 'SP1' AND status = 'failed'")
      .all();
    assert.equal(failed.filter((r) => r.rule_type === 'digest').length, 1);
    assert.equal(failed.filter((r) => r.rule_type === 'overdue').length, 1);
    assert.match(failed.find((r) => r.rule_type === 'overdue').detail, /SMTP refused mail/);
  });

  test('a failed item is retried the next day, a sent one is not', async () => {
    await engine.run({ date: RUN, senders: fakeSender({ failFor: ['SP1'] }).senders });
    const tomorrow = fakeSender();
    await engine.run({ date: D(RUN, 1), senders: tomorrow.senders });
    assert.deepEqual(tomorrow.sent.map((d) => d.rep.id), ['SP1']);
  });

  test('the dashboard status reflects what happened', async () => {
    await engine.run({ date: RUN, senders: fakeSender({ failFor: ['SP1'] }).senders });
    const status = engine.digestStatus({ date: RUN });
    assert.equal(status.today.date, RUN);
    assert.equal(status.today.sent, 1);
    assert.equal(status.today.failed, 1);
    const one = status.today.reps.find((r) => r.rep_id === 'SP1');
    assert.equal(one.status, 'failed');
    assert.match(one.error, /SMTP refused mail/);
  });

  test('a deduped re-run does not overwrite the recorded outcome', async () => {
    await engine.run({ date: RUN, senders: fakeSender().senders });
    await engine.run({ date: RUN, senders: fakeSender().senders });
    const status = engine.digestStatus({ date: RUN });
    assert.equal(status.today.sent, 2, 'the real send still wins over the later skip rows');
  });
});

// ===========================================================================
// the log API surface
// ===========================================================================

describe('reminders log reads', () => {
  const RUN = '2026-08-04';

  beforeEach(async () => {
    addRep('SP1', 'Anil Mehta');
    addCustomer('C1', 'Sharma Cycle Mart', { outstanding: 12000 });
    addInvoice('I-1', { customer: 'C1', rep: 'SP1', date: '2026-06-01', due: '2026-06-20', balance: 12000, number: 'INV-1' });
    await engine.run({ date: RUN, senders: fakeSender().senders });
  });

  test('filters by date, rep and rule type', () => {
    assert.equal(engine.listLog({ date: RUN }).total, 2);
    assert.equal(engine.listLog({ date: D(RUN, 1) }).total, 0);
    assert.equal(engine.listLog({ rep: 'SP1' }).total, 2);
    assert.equal(engine.listLog({ ruleType: 'overdue' }).total, 1);
    assert.equal(engine.listLog({ ruleType: 'digest' }).counts.sent, 1);
  });

  test('rows carry a parsed detail and a human label', () => {
    const row = engine.listLog({ ruleType: 'overdue' }).rows[0];
    assert.equal(row.rep_name, 'Anil Mehta');
    assert.equal(row.entity_type, 'invoice');
    assert.equal(row.detail.balance, 12000);
    assert.match(row.label, /INV-1 · Sharma Cycle Mart/);
  });

  test('paging works', () => {
    const first = engine.listLog({ limit: 1, offset: 0 });
    const second = engine.listLog({ limit: 1, offset: 1 });
    assert.equal(first.rows.length, 1);
    assert.equal(first.total, 2);
    assert.notEqual(first.rows[0].id, second.rows[0].id);
  });
});

// ===========================================================================
// cron wiring
// ===========================================================================

describe('cron schedule', () => {
  test('the send time becomes a Mon–Sat cron expression', () => {
    assert.equal(cronJobs.digestCronExpr('09:00'), '0 9 * * 1-6');
    assert.equal(cronJobs.digestCronExpr('07:05'), '5 7 * * 1-6');
    assert.equal(cronJobs.digestCronExpr('23:59'), '59 23 * * 1-6');
  });

  test('nonsense falls back to 09:00 rather than throwing', () => {
    assert.equal(cronJobs.digestCronExpr('not a time'), '0 9 * * 1-6');
    assert.equal(cronJobs.digestCronExpr(''), '0 9 * * 1-6');
    assert.equal(cronJobs.digestCronExpr('99:99'), '0 9 * * 1-6');
  });

  test('the send time is read from settings', () => {
    config.setSetting('digest_send_time', '08:30');
    assert.equal(cronJobs.currentSendTime(), '08:30');
    assert.equal(cronJobs.digestCronExpr(cronJobs.currentSendTime()), '30 8 * * 1-6');
    config.setSetting('digest_send_time', 'garbage');
    assert.equal(cronJobs.currentSendTime(), '09:00');
  });

  test('ENABLE_CRON=false keeps every scheduler down', () => {
    assert.equal(cronJobs.isEnabled(), false);
    assert.deepEqual(cronJobs.start(), { enabled: false, started: false, jobs: [] });
    assert.equal(cronJobs.getStatus().started, false);
  });
});

// ===========================================================================
// per-rule automatic / manual control
// ===========================================================================

/**
 * A rep with something to say under every one of the four rules, so a digest
 * can be narrowed and the missing sections actually mean something.
 * 2026-08-04 is a Tuesday: focus rides in on the first-of-month catch-up.
 */
function seedAllFourRules() {
  addRep('SP1', 'Anil Mehta');

  // overdue: due 2026-06-20, well past the 1-day cut-off
  addCustomer('C1', 'Sharma Cycle Mart', { outstanding: 12000 });
  addInvoice('I-1', { customer: 'C1', rep: 'SP1', date: '2026-06-01', due: '2026-06-20', balance: 12000, number: 'INV-1' });
  // cheque: deposits exactly cheque_lead_days (3) out
  addCheque({ customer: 'C1', rep: 'SP1', deposit: '2026-08-07', amount: 50000, number: '400001' });
  // focus: an open plan for the month
  addFocus({ month: '2026-08', customer: 'C1', rep: 'SP1', note: 'Reorder due' });
  // dormant: last invoice in January, nothing owed (so it is not ALSO overdue)
  addCustomer('C2', 'Frontier Sports', { outstanding: 0 });
  addInvoice('I-2', { customer: 'C2', rep: 'SP1', date: '2026-01-05', balance: 0, status: 'paid', number: 'INV-2' });
}

const RULE_DATE = '2026-08-04';
const sectionCounts = (digest) => ({
  overdue: digest.sections.overdue.length,
  cheques: digest.sections.cheques.length,
  dormant: digest.sections.dormant.length,
  focus: digest.sections.focus.length,
});

describe('rule selection: evaluate() only runs what it was asked for', () => {
  beforeEach(seedAllFourRules);

  test('by default all four rules contribute', () => {
    const digest = engine.evaluate({ date: RULE_DATE }).digests[0];
    assert.deepEqual(sectionCounts(digest), { overdue: 1, cheques: 1, dormant: 1, focus: 1 });
  });

  test('a narrowed run carries only those sections', () => {
    const digest = engine.evaluate({ date: RULE_DATE, rules: ['dormant', 'focus'] }).digests[0];
    assert.deepEqual(sectionCounts(digest), { overdue: 0, cheques: 0, dormant: 1, focus: 1 });
    assert.match(digest.text, /FOCUS PLAN/);
    assert.match(digest.text, /DORMANT/);
    assert.ok(!digest.text.includes('OVERDUE'));
    assert.ok(!digest.text.includes('CHEQUES DUE'));
  });

  test('the complementary selection carries exactly the other two', () => {
    const digest = engine.evaluate({ date: RULE_DATE, rules: ['overdue', 'cheque'] }).digests[0];
    assert.deepEqual(sectionCounts(digest), { overdue: 1, cheques: 1, dormant: 0, focus: 0 });
    assert.match(digest.text, /OVERDUE/);
    assert.match(digest.text, /CHEQUES DUE/);
    assert.ok(!digest.text.includes('DORMANT'));
  });

  test('the selection is reported back, in digest order, with junk dropped', () => {
    const evaluation = engine.evaluate({ date: RULE_DATE, rules: ['focus', 'nonsense', 'overdue'] });
    assert.deepEqual(evaluation.rules, ['overdue', 'focus']);
    assert.deepEqual(evaluation.stats.rules, ['overdue', 'focus']);
    assert.equal(evaluation.rulesKey, 'focus,overdue');
  });

  test('a rep left with nothing after narrowing gets no digest at all', () => {
    getDb().prepare('DELETE FROM cheques').run();
    const evaluation = engine.evaluate({ date: RULE_DATE, rules: ['cheque'] });
    assert.deepEqual(evaluation.digests, []);
  });

  test('narrowing writes nothing (evaluate stays pure)', () => {
    const before = logCount();
    engine.evaluate({ date: RULE_DATE, rules: ['overdue'] });
    assert.equal(logCount(), before);
  });
});

describe('rule selection: the scheduled digest respects the toggles', () => {
  beforeEach(seedAllFourRules);

  test('automaticRules() reads the four settings', () => {
    assert.deepEqual(engine.automaticRules(), ['overdue', 'cheque', 'dormant', 'focus']);
    config.setSetting('rule_overdue_enabled', false);
    config.setSetting('rule_cheque_enabled', false);
    assert.deepEqual(engine.automaticRules(), ['dormant', 'focus']);
  });

  test('a rule switched off is absent from the scheduled digest, the others still go', async () => {
    config.setSetting('rule_overdue_enabled', false);
    config.setSetting('rule_cheque_enabled', false);

    const fake = fakeSender();
    const result = await engine.run({ date: RULE_DATE, rules: engine.automaticRules(), senders: fake.senders });

    assert.equal(fake.sent.length, 1);
    assert.deepEqual(sectionCounts(fake.sent[0]), { overdue: 0, cheques: 0, dormant: 1, focus: 1 });
    assert.equal(result.results[0].status, 'sent');

    // and only the rules that ran left item rows
    const ruleTypes = getDb()
      .prepare("SELECT DISTINCT rule_type FROM reminders_log WHERE rule_type <> 'digest' ORDER BY rule_type")
      .all()
      .map((r) => r.rule_type);
    assert.deepEqual(ruleTypes, ['dormant', 'focus']);
  });

  test('every rule off then nothing sent and NOT a single log row', async () => {
    for (const key of engine.RULE_KEYS) config.setSetting(`rule_${key}_enabled`, false);
    assert.deepEqual(engine.automaticRules(), []);

    const fake = fakeSender();
    const result = await engine.run({ date: RULE_DATE, rules: engine.automaticRules(), senders: fake.senders });

    assert.equal(fake.sent.length, 0);
    assert.deepEqual(result.digests, []);
    assert.deepEqual(result.results, []);
    assert.equal(result.skipped, 'no rules selected');
    assert.equal(logCount(), 0, 'nothing was attempted, so nothing is recorded');
  });

  test('the cron job itself skips cleanly when everything is manual', async () => {
    for (const key of engine.RULE_KEYS) config.setSetting(`rule_${key}_enabled`, false);
    const summary = await cronJobs.runDigestJob();
    assert.equal(summary.skipped, true);
    assert.match(summary.reason, /no automatic rules/);
    assert.equal(logCount(), 0);
  });

  test('the toggles never constrain a manual run', async () => {
    // overdue + cheque are manual-only...
    config.setSetting('rule_overdue_enabled', false);
    config.setSetting('rule_cheque_enabled', false);

    // ...but asking for them by hand still works
    const fake = fakeSender();
    await engine.run({ date: RULE_DATE, rules: ['overdue', 'cheque'], senders: fake.senders });
    assert.equal(fake.sent.length, 1);
    assert.deepEqual(sectionCounts(fake.sent[0]), { overdue: 1, cheques: 1, dormant: 0, focus: 0 });
  });

  test('a bare run() is still all four, whatever the toggles say', async () => {
    for (const key of engine.RULE_KEYS) config.setSetting(`rule_${key}_enabled`, false);
    const fake = fakeSender();
    await engine.run({ date: RULE_DATE, senders: fake.senders });
    assert.equal(fake.sent.length, 1);
    assert.deepEqual(sectionCounts(fake.sent[0]), { overdue: 1, cheques: 1, dormant: 1, focus: 1 });
  });
});

describe('rule selection: the per-rep/day guard is keyed on the rule set', () => {
  beforeEach(seedAllFourRules);

  test('the morning dormant+focus digest does not block an afternoon cheque+overdue run', async () => {
    const morning = fakeSender();
    await engine.run({ date: RULE_DATE, rules: ['dormant', 'focus'], senders: morning.senders });
    assert.equal(morning.sent.length, 1);

    const afternoon = fakeSender();
    const result = await engine.run({ date: RULE_DATE, rules: ['overdue', 'cheque'], senders: afternoon.senders });
    assert.equal(afternoon.sent.length, 1, 'a different rule set is a different digest');
    assert.equal(result.results[0].status, 'sent');
    assert.deepEqual(sectionCounts(afternoon.sent[0]), { overdue: 1, cheques: 1, dormant: 0, focus: 0 });
  });

  test('and the other way round', async () => {
    const first = fakeSender();
    await engine.run({ date: RULE_DATE, rules: ['overdue', 'cheque'], senders: first.senders });
    assert.equal(first.sent.length, 1);

    const second = fakeSender();
    await engine.run({ date: RULE_DATE, rules: ['dormant', 'focus'], senders: second.senders });
    assert.equal(second.sent.length, 1);
  });

  test('re-running the SAME rule set the same day is still refused', async () => {
    await engine.run({ date: RULE_DATE, rules: ['dormant', 'focus'], senders: fakeSender().senders });

    // wipe the item rows so the rules would happily re-compose: only the
    // digest guard stands between the rep and a duplicate
    getDb().prepare("DELETE FROM reminders_log WHERE rule_type <> 'digest'").run();

    const again = fakeSender();
    const result = await engine.run({ date: RULE_DATE, rules: ['focus', 'dormant'], senders: again.senders });
    assert.equal(again.sent.length, 0, 'order of the list must not matter');
    assert.equal(result.results[0].status, 'skipped_dedupe');
  });

  test('the guard row records which rules it covers', async () => {
    await engine.run({ date: RULE_DATE, rules: ['dormant', 'focus'], senders: fakeSender().senders });
    const row = getDb().prepare("SELECT entity_type, entity_id, detail FROM reminders_log WHERE rule_type = 'digest'").get();
    assert.equal(row.entity_type, 'rules');
    assert.equal(row.entity_id, 'dormant,focus');
    assert.deepEqual(JSON.parse(row.detail).rules, ['dormant', 'focus']);
  });

  test('a legacy digest row (no rule set recorded) still blocks an all-rules run', async () => {
    // exactly what rows written before rule selection existed look like
    logSent({ date: RULE_DATE, ruleType: 'digest', entityType: null, entityId: null, rep: 'SP1' });
    const fake = fakeSender();
    const result = await engine.run({ date: RULE_DATE, senders: fake.senders });
    assert.equal(fake.sent.length, 0);
    assert.equal(result.results[0].status, 'skipped_dedupe');
  });

  test('a legacy digest row does NOT block a narrowed run', async () => {
    logSent({ date: RULE_DATE, ruleType: 'digest', entityType: null, entityId: null, rep: 'SP1' });
    const fake = fakeSender();
    await engine.run({ date: RULE_DATE, rules: ['cheque'], senders: fake.senders });
    assert.equal(fake.sent.length, 1);
  });

  test('item-level dedupe still applies across differently-scoped runs', async () => {
    await engine.run({ date: RULE_DATE, rules: ['overdue'], senders: fakeSender().senders });

    // the invoice went out this morning; an all-rules run this afternoon must
    // not chase it again, even though the digest guard lets the run through
    const afternoon = fakeSender();
    await engine.run({ date: RULE_DATE, senders: afternoon.senders });
    assert.equal(afternoon.sent.length, 1);
    assert.deepEqual(sectionCounts(afternoon.sent[0]), { overdue: 0, cheques: 1, dormant: 1, focus: 1 });
  });

  test('dry_run reports the dedupe verdict for the rule set it was asked about', async () => {
    await engine.run({ date: RULE_DATE, rules: ['dormant', 'focus'], senders: fakeSender().senders });
    getDb().prepare("DELETE FROM reminders_log WHERE rule_type <> 'digest'").run();

    const same = await engine.run({ date: RULE_DATE, rules: ['dormant', 'focus'], dryRun: true });
    assert.deepEqual(same.results.map((r) => r.wouldDedupe), [true]);

    const other = await engine.run({ date: RULE_DATE, rules: ['overdue', 'cheque'], dryRun: true });
    assert.deepEqual(other.results.map((r) => r.wouldDedupe), [false]);
  });
});

describe('rule selection over HTTP', () => {
  let server;
  let origin;
  let cookie = null;

  before(async () => {
    const adminUser = require('../src/services/adminUser');
    getDb().prepare('DELETE FROM admin_user').run();
    adminUser.ensureAdminUser();
    const { createApp } = require('../src/index');
    const app = createApp(getDb());
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;

    const res = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  const call = (pathname, body) =>
    fetch(origin + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  test('an unknown rule name is a 400', async () => {
    const res = await call('/api/reminders/run', { dry_run: true, rules: ['overdue', 'bananas'] });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'invalid request');
  });

  test('an empty rule list is a 400 rather than a silent no-op', async () => {
    assert.equal((await call('/api/reminders/run', { dry_run: true, rules: [] })).status, 400);
  });

  test('a valid selection is honoured and echoed back', async () => {
    seedAllFourRules();
    const res = await call('/api/reminders/run', { date: RULE_DATE, dry_run: true, rules: ['cheque'] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json.rules, ['cheque']);
    assert.equal(json.digests.length, 1);
    assert.deepEqual(sectionCounts(json.digests[0]), { overdue: 0, cheques: 1, dormant: 0, focus: 0 });
  });

  test('omitting rules still means all four', async () => {
    seedAllFourRules();
    const res = await call('/api/reminders/run', { date: RULE_DATE, dry_run: true });
    const json = await res.json();
    assert.deepEqual(json.rules, ['overdue', 'cheque', 'dormant', 'focus']);
    assert.deepEqual(sectionCounts(json.digests[0]), { overdue: 1, cheques: 1, dormant: 1, focus: 1 });
  });

  test('the preview accepts a comma list and rejects junk', async () => {
    seedAllFourRules();
    const ok = await call(`/api/reminders/preview?date=${RULE_DATE}&rules=dormant,focus`);
    assert.equal(ok.status, 200);
    const json = await ok.json();
    assert.deepEqual(json.rules, ['dormant', 'focus']);
    assert.deepEqual(sectionCounts(json.digests[0]), { overdue: 0, cheques: 0, dormant: 1, focus: 1 });

    assert.equal((await call('/api/reminders/preview?rules=dormant,bananas')).status, 400);
  });

  test('the status route advertises the rule keys and which are automatic', async () => {
    config.setSetting('rule_cheque_enabled', false);
    const json = await (await call('/api/reminders/status')).json();
    assert.deepEqual(json.ruleKeys, ['overdue', 'cheque', 'dormant', 'focus']);
    assert.deepEqual(json.automaticRules, ['overdue', 'dormant', 'focus']);
  });

  test('the four toggles round-trip through /api/settings', async () => {
    const res = await fetch(`${origin}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ rule_overdue_enabled: false, rule_focus_enabled: false }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.settings.rule_overdue_enabled, false);
    assert.equal(json.settings.rule_cheque_enabled, true);
    assert.equal(json.settings.rule_focus_enabled, false);
    assert.deepEqual(engine.automaticRules(), ['cheque', 'dormant']);
  });
});
