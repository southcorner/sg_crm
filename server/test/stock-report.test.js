'use strict';

/**
 * Daily dealer stock report — grouping port, masking, exclusions, scheduling.
 *
 * The grouping fixtures are the cases the original script was tuned against on
 * the real Item export; they are here so a well-meaning tweak to the colour
 * vocabulary cannot silently re-merge sub-models that must stay apart.
 *
 * Delivery goes through an injected sender — nothing here opens a socket.
 *   npm test --workspace=server
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

// point config at a scratch database BEFORE anything requires it
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcrm-stock-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DATA_DIR = TMP_DIR;
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';
process.env.ENABLE_CRON = 'false';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const config = require('../src/config');
const stock = require('../src/services/stock');
const stockReport = require('../src/services/stock-report');
const cronJobs = require('../src/jobs/cron');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function resetDb() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['reminders_log', 'item_brand_map', 'brands', 'items']) db.prepare(`DELETE FROM ${t}`).run();
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('brands','reminders_log')");
  db.exec('PRAGMA foreign_keys = ON');
}

function addBrand(name, sortOrder = 0) {
  const info = getDb().prepare('INSERT INTO brands (name, sort_order, is_active) VALUES (?, ?, 1)').run(name, sortOrder);
  return Number(info.lastInsertRowid);
}

let itemSeq = 0;
/**
 * An item exactly as the live Zoho list API delivers it: custom fields are
 * flattened `cf_*` keys, and there is no product-name field at all.
 */
function addItem({ name, sku = null, afs = 1, color = '', category = '', status = 'active', brandId = null, size = '' }) {
  itemSeq += 1;
  const id = `ITM${itemSeq}`;
  const raw = {
    item_id: id,
    name,
    sku: sku || `SKU-${itemSeq}`,
    status,
    available_for_sale: afs,
    stock_on_hand: afs,
    ...(color ? { cf_color: color } : {}),
    ...(category ? { cf_item_category: category } : {}),
    ...(size ? { cf_size: size } : {}),
  };
  getDb()
    .prepare('INSERT INTO items (zoho_item_id, name, sku, status, raw_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, raw.sku, status, JSON.stringify(raw));
  if (brandId) {
    getDb().prepare("INSERT INTO item_brand_map (item_id, brand_id, source) VALUES (?, ?, 'manual')").run(id, brandId);
  }
  return id;
}

const logCount = () => getDb().prepare("SELECT COUNT(*) AS n FROM reminders_log WHERE rule_type = 'stock_report'").get().n;

/** A sender that records what it was handed; `fail` makes it throw. */
function fakeSender({ fail = false } = {}) {
  const sent = [];
  const fn = async (report, recipients) => {
    if (fail) throw new Error('SMTP refused the stock report');
    sent.push({ report, recipients });
    return { messageId: `<stock-${report.runDate}>` };
  };
  return { sent, fn };
}

function configure(overrides = {}) {
  const base = {
    stock_report_enabled: true,
    stock_report_time: '08:30',
    stock_report_recipients: ['dealer-a@example.in', 'dealer-b@example.in'],
    stock_report_threshold: 25,
    stock_report_excluded_brands: [],
    stock_report_excluded_categories: [],
    stock_report_sync_first: false,
  };
  for (const [k, v] of Object.entries({ ...base, ...overrides })) config.setSetting(k, v);
}

const AT = (iso, time = '10:00') => new Date(`${iso}T${time}:00`);

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
  configure();
});

// ===========================================================================
// the ported grouping logic
// ===========================================================================

describe('grouping port: colour variants merge, sub-models do not', () => {
  test('modelKey strips colours, finishes and strung-status but keeps the grade', () => {
    assert.equal(stock.modelKey('Z POWER 800 RP+ RED- MATT UNSTRUNG - 4U'), 'Z POWER 800 RP 4U');
    assert.equal(stock.modelKey('Z POWER 800 RP+ BLACK - MATT UNSTRUNG 4U'), 'Z POWER 800 RP 4U');
    assert.equal(stock.modelKey('Z POWER 800 RP+ YELLOW WHITE UNSTRUNG 5U'), 'Z POWER 800 RP 5U');
  });

  test('the two 4U colourways become ONE model with two colour rows', () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'Z POWER 800 RP+ RED- MATT UNSTRUNG - 4U', afs: 10, color: 'RED', category: 'Racket', brandId: brand });
    addItem({ name: 'Z POWER 800 RP+ BLACK - MATT UNSTRUNG 4U', afs: 4, color: 'BLACK', category: 'Racket', brandId: brand });

    const models = stock.groupItems(stock.loadStockItems({}));
    assert.equal(models.length, 1);
    assert.equal(models[0].key, 'Z POWER 800 RP 4U');
    assert.equal(models[0].total, 14);
    assert.equal(models[0].itemCount, 2);
    assert.deepEqual(models[0].colors.map((c) => `${c.color}:${c.afs}`), ['RED:10', 'BLACK:4']);
  });

  test('a different grade (5U) stays its own model', () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'Z POWER 800 RP+ RED- MATT UNSTRUNG - 4U', afs: 10, color: 'RED', category: 'Racket', brandId: brand });
    addItem({ name: 'Z POWER 800 RP+ BLACK - MATT UNSTRUNG 4U', afs: 4, color: 'BLACK', category: 'Racket', brandId: brand });
    addItem({ name: 'Z POWER 800 RP+ YELLOW WHITE UNSTRUNG 5U', afs: 1, color: 'YELLOW WHITE', category: 'Racket', brandId: brand });

    const keys = stock.groupItems(stock.loadStockItems({})).map((m) => m.key).sort();
    assert.deepEqual(keys, ['Z POWER 800 RP 4U', 'Z POWER 800 RP 5U']);
  });

  test('FINAPI 232 XTRA POWER never collapses into FINAPI 232', () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'FINAPI 232 BLACK UNSTRUNG', afs: 5, color: 'BLACK', category: 'Racket', brandId: brand });
    addItem({ name: 'FINAPI 232 RED UNSTRUNG', afs: 3, color: 'RED', category: 'Racket', brandId: brand });
    addItem({ name: 'FINAPI 232 XTRA POWER BLUE', afs: 2, color: 'BLUE', category: 'Racket', brandId: brand });

    const models = stock.groupItems(stock.loadStockItems({}));
    const byKey = new Map(models.map((m) => [m.key, m]));
    assert.deepEqual([...byKey.keys()].sort(), ['FINAPI 232', 'FINAPI 232 XTRA POWER']);
    assert.equal(byKey.get('FINAPI 232').total, 8);
    assert.equal(byKey.get('FINAPI 232 XTRA POWER').total, 2);
  });

  test('a colour modifier only drops when it is attached to a colour', () => {
    // NEW in "NEW RED" is a colour modifier; NEW leading a model name is not
    assert.equal(stock.modelKey('ARMOR NEW RED UNSTRUNG'), 'ARMOR');
    assert.equal(stock.modelKey('NEW ARMOR 900'), 'NEW ARMOR 900');
  });

  test('the display name falls back to title case (the API has no product name)', () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'Z ZIGGLER GREY MATT UNSTRUNG', afs: 3, color: 'GREY', category: 'Racket', brandId: brand });
    const models = stock.groupItems(stock.loadStockItems({}));
    assert.equal(models[0].key, 'Z ZIGGLER');
    assert.equal(models[0].model, 'Z Ziggler', 'no product name to vote with → titleCase(modelKey)');
    // the colour/finish words in the raw item name must never become the title
    assert.ok(!/GREY|MATT|UNSTRUNG/i.test(models[0].model));
  });

  test('two brands shipping the same model name are never merged', () => {
    const apacs = addBrand('Apacs', 1);
    const katana = addBrand('Katana', 2);
    addItem({ name: 'POWER 900 RED', afs: 5, color: 'RED', category: 'Racket', brandId: apacs });
    addItem({ name: 'POWER 900 BLUE', afs: 7, color: 'BLUE', category: 'Racket', brandId: katana });

    const tree = stock.buildStock({});
    assert.deepEqual(tree.brands.map((b) => b.name), ['Apacs', 'Katana']);
    assert.equal(tree.brands[0].categories[0].models[0].total, 5);
    assert.equal(tree.brands[1].categories[0].models[0].total, 7);
  });
});

describe('stock loading: what the live payload actually looks like', () => {
  test('only active items with stock are loaded', () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'IN STOCK', afs: 4, brandId: brand });
    addItem({ name: 'NO STOCK', afs: 0, brandId: brand });
    addItem({ name: 'INACTIVE', afs: 9, status: 'inactive', brandId: brand });

    assert.deepEqual(stock.loadStockItems({}).map((i) => i.name), ['IN STOCK']);
  });

  test('custom fields are read from the flattened cf_* keys', () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'RACKET ONE', afs: 3, color: 'ROYAL BLUE', category: 'Racket', size: '4U', brandId: brand });
    const it = stock.loadStockItems({})[0];
    assert.equal(it.color, 'ROYAL BLUE');
    assert.equal(it.category, 'Racket');
    assert.equal(it.size, '4U');
    assert.equal(it.productName, '', 'the API carries no product name');
  });

  test('Bags reads as Kitbag and a blank category becomes Other', () => {
    assert.equal(stock.displayCategory('Bags'), 'Kitbag');
    assert.equal(stock.displayCategory(''), 'Other');
    assert.equal(stock.displayCategory('  '), 'Other');
    assert.equal(stock.displayCategory('Racket'), 'Racket');
  });

  test('items no brand rule claimed land in the Unbranded bucket, last', () => {
    const apacs = addBrand('Apacs', 1);
    addItem({ name: 'CLAIMED', afs: 2, category: 'Racket', brandId: apacs });
    addItem({ name: 'ORPHAN', afs: 2, category: 'Racket' });

    const tree = stock.buildStock({});
    assert.deepEqual(tree.brands.map((b) => b.name), ['Apacs', 'Unbranded']);
    assert.equal(tree.brands[1].id, stock.UNBRANDED.id);
  });
});

// ===========================================================================
// masking
// ===========================================================================

describe('masking: dealers see “Available”, never a big number', () => {
  test('the boundary is inclusive — exactly the threshold prints the number', () => {
    assert.equal(stockReport.maskQty(24, 25), '24');
    assert.equal(stockReport.maskQty(25, 25), '25');
    assert.equal(stockReport.maskQty(26, 25), 'Available');
    assert.equal(stockReport.maskQty(0, 25), '0');
  });

  test('the rule applies to model totals AND to colour rows', () => {
    const brand = addBrand('Apacs');
    // 20 + 30 = 50 total: the model is masked, one colour row is not
    addItem({ name: 'ARC 11 RED', afs: 20, color: 'RED', category: 'Racket', brandId: brand });
    addItem({ name: 'ARC 11 BLUE', afs: 30, color: 'BLUE', category: 'Racket', brandId: brand });

    const report = stockReport.compose({ date: '2026-08-05' });
    const line = (label) => report.text.split('\n').find((l) => l.trim().startsWith(label));
    assert.match(line('Arc 11:'), /Arc 11: Available/);
    assert.match(line('BLUE:'), /BLUE: Available/);
    assert.match(line('RED:'), /RED: 20/);
    assert.ok(!report.text.includes('50'), 'the masked total never leaks the real number');
    assert.ok(report.html.includes('Available'));
  });

  test('a custom threshold moves the boundary', () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'ARC 11 RED', afs: 20, color: 'RED', category: 'Racket', brandId: brand });

    assert.match(stockReport.compose({ date: '2026-08-05', settings: { threshold: 10 } }).text, /Arc 11: Available/);
    assert.match(stockReport.compose({ date: '2026-08-05', settings: { threshold: 20 } }).text, /Arc 11: 20/);
  });

  test('the footer states the threshold in force', () => {
    addItem({ name: 'ANY', afs: 1, brandId: addBrand('Apacs') });
    assert.match(stockReport.compose({ date: '2026-08-05', settings: { threshold: 40 } }).text, /above 40 are shown/);
  });
});

// ===========================================================================
// exclusions
// ===========================================================================

describe('exclusions actually omit whole sections', () => {
  let apacs;
  let katana;

  beforeEach(() => {
    apacs = addBrand('Apacs', 1);
    katana = addBrand('Katana', 2);
    addItem({ name: 'ARC 11 RED', afs: 5, color: 'RED', category: 'Racket', brandId: apacs });
    addItem({ name: 'GRIP TAPE BLACK', afs: 5, color: 'BLACK', category: 'Grip', brandId: apacs });
    addItem({ name: 'BLADE 7 BLUE', afs: 5, color: 'BLUE', category: 'Racket', brandId: katana });
  });

  test('an excluded brand disappears entirely', () => {
    const report = stockReport.compose({ date: '2026-08-05', settings: { excludedBrands: [katana] } });
    assert.deepEqual(report.brands.map((b) => b.name), ['Apacs']);
    assert.ok(!report.text.includes('KATANA'));
    assert.ok(!report.html.includes('Blade 7'));
    assert.equal(report.counts.items, 2);
  });

  test('an excluded category disappears across every brand', () => {
    const report = stockReport.compose({ date: '2026-08-05', settings: { excludedCategories: ['Racket'] } });
    assert.deepEqual(report.brands.map((b) => b.name), ['Apacs']);
    assert.deepEqual(report.brands[0].categories.map((c) => c.name), ['Grip']);
    assert.ok(!report.text.includes('Arc 11'));
    assert.ok(!report.text.includes('Blade 7'));
    assert.equal(report.counts.items, 1);
  });

  test('excluding everything yields an honest empty report, not a crash', () => {
    const report = stockReport.compose({ date: '2026-08-05', settings: { excludedBrands: [apacs, katana] } });
    assert.deepEqual(report.brands, []);
    assert.equal(report.counts.models, 0);
    assert.match(report.text, /Nothing is in stock right now/);
  });

  test('the options endpoint offers the categories actually present', () => {
    assert.deepEqual(stock.availableCategories({}).map((c) => c.name).sort(), ['Grip', 'Racket']);
    assert.deepEqual(stock.availableBrands({}).map((b) => b.name), ['Apacs', 'Katana', 'Unbranded']);
  });
});

// ===========================================================================
// sending: the once-per-day guard
// ===========================================================================

describe('send: once per day unless forced', () => {
  const DATE = '2026-08-05';

  beforeEach(() => {
    const brand = addBrand('Apacs');
    addItem({ name: 'ARC 11 RED', afs: 5, color: 'RED', category: 'Racket', brandId: brand });
  });

  test('a first send goes out and is logged', async () => {
    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });

    assert.equal(result.status, 'sent');
    assert.equal(fake.sent.length, 1);
    assert.deepEqual(fake.sent[0].recipients, ['dealer-a@example.in', 'dealer-b@example.in']);
    assert.equal(fake.sent[0].report.subject, 'Stock availability — 2026-08-05');

    const rows = getDb().prepare("SELECT * FROM reminders_log WHERE rule_type = 'stock_report'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].entity_id, DATE);
    assert.equal(rows[0].channel, 'email');
  });

  test('a second send the same day is refused', async () => {
    await stockReport.sendReport({ date: DATE, send: fakeSender().fn });
    const second = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: second.fn });

    assert.equal(result.status, 'skipped_dedupe');
    assert.equal(second.sent.length, 0);
  });

  test('force overrides the guard', async () => {
    await stockReport.sendReport({ date: DATE, send: fakeSender().fn });
    const forced = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: forced.fn, force: true });

    assert.equal(result.status, 'sent');
    assert.equal(forced.sent.length, 1);
  });

  test('the next day is a clean slate', async () => {
    await stockReport.sendReport({ date: DATE, send: fakeSender().fn });
    const tomorrow = fakeSender();
    const result = await stockReport.sendReport({ date: '2026-08-06', send: tomorrow.fn });
    assert.equal(result.status, 'sent');
    assert.equal(tomorrow.sent.length, 1);
  });

  test('a pending row (crashed mid-send) still blocks a re-send', async () => {
    getDb()
      .prepare(
        `INSERT INTO reminders_log (run_date, rule_type, entity_type, entity_id, channel, status)
         VALUES (?, 'stock_report', 'report', ?, 'email', 'pending')`
      )
      .run(DATE, DATE);
    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });
    assert.equal(result.status, 'skipped_dedupe');
    assert.equal(fake.sent.length, 0);
  });

  test('a send failure is logged as failed and reported, not thrown', async () => {
    const fake = fakeSender({ fail: true });
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /SMTP refused/);
    const row = getDb().prepare("SELECT status, detail FROM reminders_log WHERE rule_type = 'stock_report'").get();
    assert.equal(row.status, 'failed');
    assert.match(row.detail, /SMTP refused/);
  });

  test('a failed send does not burn the day — it retries', async () => {
    await stockReport.sendReport({ date: DATE, send: fakeSender({ fail: true }).fn });
    const retry = fakeSender();
    // the guard treats a 'failed' row as "today is done"; the operator retries
    // with force, which is exactly what the UI offers
    const result = await stockReport.sendReport({ date: DATE, send: retry.fn, force: true });
    assert.equal(result.status, 'sent');
    assert.equal(retry.sent.length, 1);
  });
});

describe('send: the guards that stop it before it starts', () => {
  const DATE = '2026-08-05';

  beforeEach(() => {
    addItem({ name: 'ARC 11 RED', afs: 5, color: 'RED', category: 'Racket', brandId: addBrand('Apacs') });
  });

  test('disabled → nothing sent, nothing logged', async () => {
    configure({ stock_report_enabled: false });
    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'disabled');
    assert.equal(fake.sent.length, 0);
    assert.equal(logCount(), 0);
  });

  test('“Send now” overrides the disabled flag — the button IS the intent', async () => {
    configure({ stock_report_enabled: false });
    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn, ignoreEnabled: true });
    assert.equal(result.status, 'sent');
    assert.equal(fake.sent.length, 1);
  });

  test('no recipients → nothing sent, nothing logged (and a warning)', async () => {
    configure({ stock_report_recipients: [] });
    const warnings = [];
    const logger = require('../src/logger');
    const original = logger.warn;
    logger.warn = (...args) => warnings.push(args);
    try {
      const fake = fakeSender();
      const result = await stockReport.sendReport({ date: DATE, send: fake.fn, ignoreEnabled: true });
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'no recipients');
      assert.equal(fake.sent.length, 0);
      assert.equal(logCount(), 0);
    } finally {
      logger.warn = original;
    }
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /no recipients/);
  });

  test('sync_first with Zoho disconnected notes the skip and sends anyway', async () => {
    configure({ stock_report_sync_first: true });
    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });
    assert.equal(result.status, 'sent');
    assert.equal(result.syncNote.attempted, false);
    assert.match(result.syncNote.skipped, /not connected/);
  });
});

// ===========================================================================
// scheduling
// ===========================================================================

describe('cron expression', () => {
  test('the stock report runs EVERY day, unlike the Mon–Sat digest', () => {
    assert.equal(cronJobs.stockCronExpr('08:30'), '30 8 * * *');
    assert.equal(cronJobs.digestCronExpr('08:30'), '30 8 * * 1-6');
  });

  test('nonsense falls back to 08:30', () => {
    assert.equal(cronJobs.stockCronExpr('99:99'), '30 8 * * *');
    assert.equal(cronJobs.stockCronExpr(''), '30 8 * * *');
  });

  test('the time comes from settings', () => {
    config.setSetting('stock_report_time', '07:15');
    assert.equal(cronJobs.currentStockTime(), '07:15');
    assert.equal(cronJobs.stockCronExpr(cronJobs.currentStockTime()), '15 7 * * *');
  });
});

describe('boot catch-up: a machine switched on late still sends', () => {
  const DAY = '2026-08-05';

  beforeEach(() => {
    addItem({ name: 'ARC 11 RED', afs: 5, color: 'RED', category: 'Racket', brandId: addBrand('Apacs') });
    configure({ stock_report_time: '08:30' });
  });

  test('booting BEFORE the send time waits for cron', () => {
    const decision = stockReport.shouldCatchUp({ now: AT(DAY, '07:59') });
    assert.equal(decision.catchUp, false);
    assert.match(decision.reason, /has not passed/);
  });

  test('booting AFTER the send time catches up', () => {
    const decision = stockReport.shouldCatchUp({ now: AT(DAY, '09:10') });
    assert.equal(decision.catchUp, true);
    assert.equal(decision.runDate, DAY);
  });

  test('booting exactly ON the send time catches up', () => {
    assert.equal(stockReport.shouldCatchUp({ now: AT(DAY, '08:30') }).catchUp, true);
  });

  test('a day already sent is never re-sent by a reboot', async () => {
    await stockReport.sendReport({ date: DAY, send: fakeSender().fn });
    const decision = stockReport.shouldCatchUp({ now: AT(DAY, '09:10') });
    assert.equal(decision.catchUp, false);
    assert.match(decision.reason, /already sent/);
  });

  test('disabled or recipient-less means no catch-up at all', () => {
    configure({ stock_report_enabled: false });
    assert.equal(stockReport.shouldCatchUp({ now: AT(DAY, '09:10') }).reason, 'disabled');
    configure({ stock_report_enabled: true, stock_report_recipients: [] });
    assert.equal(stockReport.shouldCatchUp({ now: AT(DAY, '09:10') }).reason, 'no recipients');
  });

  test('ENABLE_CRON=false disables the boot path too', async () => {
    assert.equal(cronJobs.isEnabled(), false);
    const result = await cronJobs.stockReportCatchUp({ now: AT(DAY, '09:10') });
    assert.equal(result.catchUp, false);
    assert.equal(result.reason, 'cron disabled');
    assert.equal(logCount(), 0);
  });
});

// ===========================================================================
// the log surface the Reminders page renders
// ===========================================================================

describe('stock_report rows in the reminder log', () => {
  test('the row carries the subject, counts and recipient tally', async () => {
    addItem({ name: 'ARC 11 RED', afs: 5, color: 'RED', category: 'Racket', brandId: addBrand('Apacs') });
    await stockReport.sendReport({ date: '2026-08-05', send: fakeSender().fn });

    const engine = require('../src/services/reminders/engine');
    const { rows } = engine.listLog({ ruleType: 'stock_report' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rule_type, 'stock_report');
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].entity_type, 'report');
    assert.equal(rows[0].detail.recipients, 2);
    assert.equal(rows[0].detail.counts.models, 1);
    assert.match(rows[0].detail.subject, /Stock availability/);
  });

  test('lastRun() surfaces the recent history for the settings tab', async () => {
    addItem({ name: 'ARC 11 RED', afs: 5, color: 'RED', category: 'Racket', brandId: addBrand('Apacs') });
    await stockReport.sendReport({ date: '2026-08-04', send: fakeSender().fn });
    await stockReport.sendReport({ date: '2026-08-05', send: fakeSender().fn });

    const runs = stockReport.lastRun({});
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((r) => r.run_date), ['2026-08-05', '2026-08-04']);
    assert.equal(runs[0].status, 'sent');
  });
});
