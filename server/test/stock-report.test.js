'use strict';

/**
 * Daily dealer stock report — grouping port, masking, per-recipient profiles,
 * the attachment, scheduling and the once-per-day guard.
 *
 * The grouping fixtures are the cases the original script was tuned against on
 * the real Item export; they are here so a well-meaning tweak to the colour
 * vocabulary cannot silently re-merge sub-models that must stay apart.
 *
 * Delivery goes through an injected sender — nothing here opens an SMTP socket.
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
  for (const t of ['reminders_log', 'stock_report_profiles', 'item_brand_map', 'brands', 'items']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('brands','reminders_log','stock_report_profiles')");
  db.exec('PRAGMA foreign_keys = ON');
}

function addBrand(name, sortOrder = 0) {
  return Number(
    getDb().prepare('INSERT INTO brands (name, sort_order, is_active) VALUES (?, ?, 1)').run(name, sortOrder)
      .lastInsertRowid
  );
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

/** A sender that records what it was handed; `fail` / `failFor` make it throw. */
function fakeSender({ fail = false, failFor = [] } = {}) {
  const sent = [];
  const fn = async (report, recipients, profile) => {
    if (fail || failFor.includes(profile && profile.name)) throw new Error('SMTP refused the stock report');
    sent.push({ report, recipients, profile });
    return { messageId: `<stock-${report.runDate}-${report.profileId}>` };
  };
  return { sent, fn };
}

/** Only the three GLOBAL settings survive; everything else is per profile. */
function configure(overrides = {}) {
  const base = { stock_report_enabled: true, stock_report_time: '08:30', stock_report_sync_first: false };
  for (const [k, v] of Object.entries({ ...base, ...overrides })) config.setSetting(k, v);
}

function addProfile(overrides = {}) {
  return stockReport.createProfile(
    {
      name: 'Dealers',
      recipients: ['dealer-a@example.in', 'dealer-b@example.in'],
      excludedBrands: [],
      excludedCategories: [],
      threshold: 25,
      enabled: true,
      ...overrides,
    },
    {}
  );
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

    const byKey = new Map(stock.groupItems(stock.loadStockItems({})).map((m) => [m.key, m]));
    assert.deepEqual([...byKey.keys()].sort(), ['FINAPI 232', 'FINAPI 232 XTRA POWER']);
    assert.equal(byKey.get('FINAPI 232').total, 8);
    assert.equal(byKey.get('FINAPI 232 XTRA POWER').total, 2);
  });

  test('a colour modifier only drops when it is attached to a colour', () => {
    assert.equal(stock.modelKey('ARMOR NEW RED UNSTRUNG'), 'ARMOR');
    assert.equal(stock.modelKey('NEW ARMOR 900'), 'NEW ARMOR 900');
  });

  test('the display name falls back to title case (the API has no product name)', () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'Z ZIGGLER GREY MATT UNSTRUNG', afs: 3, color: 'GREY', category: 'Racket', brandId: brand });
    const models = stock.groupItems(stock.loadStockItems({}));
    assert.equal(models[0].key, 'Z ZIGGLER');
    assert.equal(models[0].model, 'Z Ziggler', 'no product name to vote with → titleCase(modelKey)');
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

  test('the rule applies to the brand summary in the body', () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'ARC ELEVEN RED', afs: 20, color: 'RED', category: 'Racket', brandId: brand });
    addItem({ name: 'ARC ELEVEN BLUE', afs: 30, color: 'BLUE', category: 'Racket', brandId: brand });

    const report = stockReport.compose({ profile: addProfile(), date: '2026-08-05' });
    assert.match(report.text, /Apacs: 1 model\(s\) · Available/);
    assert.ok(!report.text.includes('50'), 'the masked brand total never leaks');
  });

  test('a per-profile threshold changes what that profile sees', () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'ARC ELEVEN RED', afs: 20, color: 'RED', category: 'Racket', brandId: brand });

    const strict = stockReport.compose({ profile: addProfile({ threshold: 10 }), date: '2026-08-05' });
    const loose = stockReport.compose({ profile: addProfile({ name: 'B', threshold: 25 }), date: '2026-08-05' });
    assert.match(strict.text, /Apacs: 1 model\(s\) · Available/);
    assert.match(loose.text, /Apacs: 1 model\(s\) · 20/);
    assert.match(strict.attachment.content, /above 10 are shown/);
    assert.match(loose.attachment.content, /above 25 are shown/);
  });

  test('the footer states the threshold in force', () => {
    addItem({ name: 'ANY', afs: 1, brandId: addBrand('Apacs') });
    assert.match(
      stockReport.compose({ profile: addProfile({ threshold: 40 }), date: '2026-08-05' }).text,
      /above 40 are shown/
    );
  });
});

// ===========================================================================
// the body + attachment
// ===========================================================================

describe('the mail: a summary body pointing at the searchable attachment', () => {
  const DATE = '2026-08-05';

  beforeEach(() => {
    const apacs = addBrand('Apacs', 1);
    const katana = addBrand('Katana', 2);
    addItem({ name: 'ARC ELEVEN RED', afs: 5, color: 'RED', category: 'Racket', brandId: apacs });
    addItem({ name: 'GRIP TAPE BLACK', afs: 5, color: 'BLACK', category: 'Grip', brandId: apacs });
    addItem({ name: 'BLADE SEVEN BLUE', afs: 5, color: 'BLUE', category: 'Racket', brandId: katana });
  });

  test('the attachment is the generated browser, named for the date', () => {
    const report = stockReport.compose({ profile: addProfile(), date: DATE });
    assert.equal(report.attachment.filename, 'Stock 2026-08-05.html');
    assert.equal(report.attachment.contentType, 'text/html; charset=utf-8');
    assert.match(report.attachment.content, /<!doctype html>/);
    assert.match(report.attachment.content, /id="brandChips"/);
  });

  test('the body is a short summary, not the full catalogue', () => {
    const report = stockReport.compose({ profile: addProfile(), date: DATE });
    assert.ok(report.html.length < 8000, `body should stay small, was ${report.html.length}`);
    assert.ok(report.html.length < report.attachment.content.length, 'the attachment is the artifact now');
    assert.match(report.html, /Open the attached file/);
    assert.match(report.text, /Open the attached file — Stock 2026-08-05\.html/);
    // per-brand rollup, not per-model rows
    assert.match(report.text, /Apacs: 2 model\(s\)/);
    // categories rank by stock, then alphabetically — both are 5 here
    assert.match(report.text, /Grip \(1\) · Racket \(1\)/);
    assert.ok(!report.html.includes('Arc Eleven'), 'individual models live in the attachment');
  });

  test('body and attachment always agree on the exclusions', () => {
    const report = stockReport.compose({ profile: addProfile({ excludedCategories: ['Grip'] }), date: DATE });
    assert.ok(!report.html.includes('Grip'));
    assert.ok(!report.attachment.content.includes('Grip'));
    assert.equal(report.counts.items, 2);
    assert.equal(report.file.rows, 2);
  });

  test('an excluded brand is gone from both', () => {
    const katana = getDb().prepare("SELECT id FROM brands WHERE name = 'Katana'").get().id;
    const report = stockReport.compose({ profile: addProfile({ excludedBrands: [katana] }), date: DATE });
    assert.ok(!report.html.includes('Katana'));
    assert.ok(!report.attachment.content.includes('Katana'));
    assert.deepEqual(report.file.brands, ['Apacs']);
  });

  test('two profiles built from one dataset get different attachments', () => {
    const all = stockReport.compose({ profile: addProfile({ name: 'All' }), date: DATE });
    const rackets = stockReport.compose({
      profile: addProfile({ name: 'Rackets', excludedCategories: ['Grip'] }),
      date: DATE,
    });
    assert.notEqual(all.attachment.content, rackets.attachment.content);
    assert.equal(all.file.rows, 3);
    assert.equal(rackets.file.rows, 2);
  });

  test('an empty result is honest rather than broken', () => {
    const apacs = getDb().prepare("SELECT id FROM brands WHERE name = 'Apacs'").get().id;
    const katana = getDb().prepare("SELECT id FROM brands WHERE name = 'Katana'").get().id;
    const report = stockReport.compose({ profile: addProfile({ excludedBrands: [apacs, katana] }), date: DATE });
    assert.equal(report.counts.models, 0);
    assert.match(report.text, /Nothing is in stock right now/);
    assert.match(report.attachment.content, /<!doctype html>/);
  });
});

// ===========================================================================
// profiles
// ===========================================================================

describe('profile CRUD', () => {
  test('a profile round-trips through the database', () => {
    const created = addProfile({
      name: 'North dealers',
      excludedBrands: [0, 7],
      excludedCategories: ['Fishing'],
      threshold: 40,
    });
    assert.equal(created.name, 'North dealers');
    assert.deepEqual(created.recipients, ['dealer-a@example.in', 'dealer-b@example.in']);
    assert.deepEqual(created.excludedBrands, [0, 7]);
    assert.deepEqual(created.excludedCategories, ['Fishing']);
    assert.equal(created.threshold, 40);
    assert.equal(created.enabled, true);

    assert.deepEqual(stockReport.getProfile(created.id, {}), created);
  });

  test('updates are partial', () => {
    const p = addProfile({ threshold: 25 });
    const updated = stockReport.updateProfile(p.id, { threshold: 5 }, {});
    assert.equal(updated.threshold, 5);
    assert.deepEqual(updated.recipients, p.recipients, 'untouched fields survive');
    assert.equal(updated.name, p.name);
  });

  test('a nameless profile is refused', () => {
    assert.throws(() => stockReport.createProfile({ name: '   ' }, {}), /needs a name/);
  });

  test('the threshold is clamped to something sane', () => {
    assert.equal(addProfile({ name: 'A', threshold: 0 }).threshold, 25);
    assert.equal(addProfile({ name: 'B', threshold: -3 }).threshold, 25);
    assert.equal(addProfile({ name: 'C', threshold: 99999999 }).threshold, stockReport.MAX_THRESHOLD);
  });

  test('deleting is a 404 when it is not there', () => {
    assert.throws(() => stockReport.deleteProfile(9999, {}), /not found/);
  });

  test('only enabled profiles WITH recipients are sendable', () => {
    addProfile({ name: 'Live' });
    addProfile({ name: 'Paused', enabled: false });
    addProfile({ name: 'Empty', recipients: [] });
    assert.deepEqual(stockReport.listProfiles({}).map((p) => p.name), ['Live', 'Paused', 'Empty']);
    assert.deepEqual(stockReport.sendableProfiles({}).map((p) => p.name), ['Live']);
  });
});

// ===========================================================================
// sending, per profile
// ===========================================================================

describe('send: one mail per profile, each guarded on its own', () => {
  const DATE = '2026-08-05';
  let apacs;
  let katana;

  beforeEach(() => {
    apacs = addBrand('Apacs', 1);
    katana = addBrand('Katana', 2);
    addItem({ name: 'ARC ELEVEN RED', afs: 5, color: 'RED', category: 'Racket', brandId: apacs });
    addItem({ name: 'BLADE SEVEN BLUE', afs: 5, color: 'BLUE', category: 'Racket', brandId: katana });
  });

  test('two profiles get two mails with different attachments', async () => {
    addProfile({ name: 'Everything', recipients: ['all@x.in'] });
    addProfile({ name: 'Apacs only', recipients: ['apacs@x.in', 'apacs2@x.in'], excludedBrands: [katana] });

    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });

    assert.equal(result.sent, 2);
    assert.equal(fake.sent.length, 2);
    assert.deepEqual(fake.sent.map((s) => s.profile.name), ['Everything', 'Apacs only']);
    assert.deepEqual(fake.sent[0].recipients, ['all@x.in']);
    assert.deepEqual(fake.sent[1].recipients, ['apacs@x.in', 'apacs2@x.in']);

    assert.ok(fake.sent[0].report.attachment.content.includes('Katana'));
    assert.ok(!fake.sent[1].report.attachment.content.includes('Katana'));
    assert.notEqual(fake.sent[0].report.attachment.content, fake.sent[1].report.attachment.content);
  });

  test('each profile gets its own guard row keyed by profile and date', async () => {
    const a = addProfile({ name: 'A', recipients: ['a@x.in'] });
    const b = addProfile({ name: 'B', recipients: ['b@x.in'] });
    await stockReport.sendReport({ date: DATE, send: fakeSender().fn });

    const rows = getDb()
      .prepare("SELECT entity_id, entity_type, status FROM reminders_log WHERE rule_type='stock_report' ORDER BY id")
      .all();
    assert.deepEqual(rows.map((r) => r.entity_id), [`${a.id}:${DATE}`, `${b.id}:${DATE}`]);
    assert.ok(rows.every((r) => r.entity_type === 'profile' && r.status === 'sent'));
    assert.equal(stockReport.alreadySentToday(a.id, DATE, {}), true);
    assert.equal(stockReport.alreadySentToday(b.id, DATE, {}), true);
  });

  test('a second run the same day sends nothing', async () => {
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    await stockReport.sendReport({ date: DATE, send: fakeSender().fn });

    const second = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: second.fn });
    assert.equal(second.sent.length, 0);
    assert.equal(result.sent, 0);
    assert.deepEqual(result.results.map((r) => r.status), ['skipped_dedupe']);
  });

  test('force overrides the guard', async () => {
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    await stockReport.sendReport({ date: DATE, send: fakeSender().fn });

    const forced = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: forced.fn, force: true });
    assert.equal(result.sent, 1);
    assert.equal(forced.sent.length, 1);
  });

  test('one profile already sent does not block a new one', async () => {
    const a = addProfile({ name: 'A', recipients: ['a@x.in'] });
    await stockReport.sendReport({ date: DATE, send: fakeSender().fn });

    // the admin adds a second profile later the same day
    const b = addProfile({ name: 'B', recipients: ['b@x.in'] });
    const second = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: second.fn });

    assert.deepEqual(second.sent.map((s) => s.profile.name), ['B']);
    assert.equal(result.results.find((r) => r.profileId === a.id).status, 'skipped_dedupe');
    assert.equal(result.results.find((r) => r.profileId === b.id).status, 'sent');
  });

  test('a pending row (crashed mid-send) still blocks that profile', async () => {
    const a = addProfile({ name: 'A', recipients: ['a@x.in'] });
    getDb()
      .prepare(
        `INSERT INTO reminders_log (run_date, rule_type, entity_type, entity_id, channel, status)
         VALUES (?, 'stock_report', 'profile', ?, 'email', 'pending')`
      )
      .run(DATE, `${a.id}:${DATE}`);

    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });
    assert.equal(fake.sent.length, 0);
    assert.deepEqual(result.results.map((r) => r.status), ['skipped_dedupe']);
  });

  test('one profile failing does not cost the others their mail', async () => {
    addProfile({ name: 'Broken', recipients: ['broken@x.in'] });
    addProfile({ name: 'Fine', recipients: ['fine@x.in'] });

    const fake = fakeSender({ failFor: ['Broken'] });
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });

    assert.deepEqual(fake.sent.map((s) => s.profile.name), ['Fine']);
    assert.equal(result.sent, 1);
    assert.equal(result.failed, 1);
    const rows = getDb()
      .prepare("SELECT status, detail FROM reminders_log WHERE rule_type='stock_report' ORDER BY id")
      .all();
    assert.deepEqual(rows.map((r) => r.status), ['failed', 'sent']);
    assert.match(rows[0].detail, /SMTP refused/);
  });

  test('the next day is a clean slate', async () => {
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    await stockReport.sendReport({ date: DATE, send: fakeSender().fn });
    const tomorrow = fakeSender();
    const result = await stockReport.sendReport({ date: '2026-08-06', send: tomorrow.fn });
    assert.equal(result.sent, 1);
    assert.equal(tomorrow.sent.length, 1);
  });

  test('a single profile can be sent on its own', async () => {
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    const b = addProfile({ name: 'B', recipients: ['b@x.in'] });

    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn, profileId: b.id });
    assert.deepEqual(fake.sent.map((s) => s.profile.name), ['B']);
    assert.equal(result.results.length, 1);
  });

  test('sending one disabled profile by id still works (the button is the intent)', async () => {
    const p = addProfile({ name: 'Paused', recipients: ['p@x.in'], enabled: false });
    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn, profileId: p.id });
    assert.equal(result.sent, 1);
    assert.equal(fake.sent.length, 1);
  });
});

describe('send: the guards that stop it before it starts', () => {
  const DATE = '2026-08-05';

  beforeEach(() => {
    addItem({ name: 'ARC ELEVEN RED', afs: 5, color: 'RED', category: 'Racket', brandId: addBrand('Apacs') });
  });

  test('the master switch off → nothing sent, nothing logged', async () => {
    configure({ stock_report_enabled: false });
    addProfile({ name: 'A', recipients: ['a@x.in'] });

    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'disabled');
    assert.equal(fake.sent.length, 0);
    assert.equal(logCount(), 0);
  });

  test('“Send now” overrides the master switch', async () => {
    configure({ stock_report_enabled: false });
    addProfile({ name: 'A', recipients: ['a@x.in'] });

    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn, ignoreEnabled: true });
    assert.equal(result.sent, 1);
    assert.equal(fake.sent.length, 1);
  });

  test('no profiles at all → nothing sent, nothing logged, and a warning', async () => {
    const warnings = [];
    const logger = require('../src/logger');
    const original = logger.warn;
    logger.warn = (...args) => warnings.push(args);
    try {
      const fake = fakeSender();
      const result = await stockReport.sendReport({ date: DATE, send: fake.fn });
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'no profiles with recipients');
      assert.equal(fake.sent.length, 0);
      assert.equal(logCount(), 0);
    } finally {
      logger.warn = original;
    }
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /no enabled profile has recipients/);
  });

  test('a profile with no recipients is not sendable', async () => {
    addProfile({ name: 'Empty', recipients: [] });
    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });
    assert.equal(result.reason, 'no profiles with recipients');
    assert.equal(fake.sent.length, 0);
  });

  test('a disabled profile is skipped by the scheduled run', async () => {
    addProfile({ name: 'Paused', recipients: ['p@x.in'], enabled: false });
    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });
    assert.equal(result.reason, 'no profiles with recipients');
    assert.equal(fake.sent.length, 0);
  });

  test('sync_first with Zoho disconnected notes the skip and sends anyway', async () => {
    configure({ stock_report_sync_first: true });
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    const fake = fakeSender();
    const result = await stockReport.sendReport({ date: DATE, send: fake.fn });
    assert.equal(result.sent, 1);
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

  test('cron reports whether anything is actually configured to send', () => {
    assert.equal(cronJobs.stockReportConfigured(), false);
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    assert.equal(cronJobs.stockReportConfigured(), true);
  });
});

describe('boot catch-up: a machine switched on late still sends', () => {
  const DAY = '2026-08-05';

  beforeEach(() => {
    addItem({ name: 'ARC ELEVEN RED', afs: 5, color: 'RED', category: 'Racket', brandId: addBrand('Apacs') });
    configure({ stock_report_time: '08:30' });
  });

  test('booting BEFORE the send time waits for cron', () => {
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    const decision = stockReport.shouldCatchUp({ now: AT(DAY, '07:59') });
    assert.equal(decision.catchUp, false);
    assert.match(decision.reason, /has not passed/);
  });

  test('booting AFTER the send time catches up', () => {
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    const decision = stockReport.shouldCatchUp({ now: AT(DAY, '09:10') });
    assert.equal(decision.catchUp, true);
    assert.equal(decision.runDate, DAY);
    assert.equal(decision.pending, 1);
  });

  test('booting exactly ON the send time catches up', () => {
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    assert.equal(stockReport.shouldCatchUp({ now: AT(DAY, '08:30') }).catchUp, true);
  });

  test('a profile already sent today is not re-sent by a reboot', async () => {
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    await stockReport.sendReport({ date: DAY, send: fakeSender().fn });
    const decision = stockReport.shouldCatchUp({ now: AT(DAY, '09:10') });
    assert.equal(decision.catchUp, false);
    assert.match(decision.reason, /already sent/);
  });

  test('a profile added after the others went out is still caught up on reboot', async () => {
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    await stockReport.sendReport({ date: DAY, send: fakeSender().fn });
    addProfile({ name: 'B', recipients: ['b@x.in'] });

    const decision = stockReport.shouldCatchUp({ now: AT(DAY, '09:10') });
    assert.equal(decision.catchUp, true);
    assert.equal(decision.pending, 1, 'only the profile that has not gone out');
  });

  test('creating a profile never sends by itself', () => {
    const before = logCount();
    addProfile({ name: 'Brand new', recipients: ['new@x.in'] });
    assert.equal(logCount(), before, 'no mail, no log row — it joins the next scheduled run');
  });

  test('disabled or profile-less means no catch-up at all', () => {
    configure({ stock_report_enabled: false });
    addProfile({ name: 'A', recipients: ['a@x.in'] });
    assert.equal(stockReport.shouldCatchUp({ now: AT(DAY, '09:10') }).reason, 'disabled');
    configure({ stock_report_enabled: true });
    stockReport.updateProfile(stockReport.listProfiles({})[0].id, { recipients: [] }, {});
    assert.equal(stockReport.shouldCatchUp({ now: AT(DAY, '09:10') }).reason, 'no profiles with recipients');
  });

  test('ENABLE_CRON=false disables the boot path too', async () => {
    addProfile({ name: 'A', recipients: ['a@x.in'] });
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
  test('the row names the profile and counts the recipients', async () => {
    addItem({ name: 'ARC ELEVEN RED', afs: 5, color: 'RED', category: 'Racket', brandId: addBrand('Apacs') });
    addProfile({ name: 'North dealers', recipients: ['a@x.in', 'b@x.in'] });
    await stockReport.sendReport({ date: '2026-08-05', send: fakeSender().fn });

    const engine = require('../src/services/reminders/engine');
    const { rows } = engine.listLog({ ruleType: 'stock_report' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].entity_type, 'profile');
    assert.equal(rows[0].detail.profile, 'North dealers');
    assert.equal(rows[0].detail.recipients, 2);
    assert.equal(rows[0].detail.attachment, 'Stock 2026-08-05.html');
    assert.equal(rows[0].detail.counts.models, 1);
  });

  test('lastRun() can be narrowed to one profile', async () => {
    addItem({ name: 'ARC ELEVEN RED', afs: 5, color: 'RED', category: 'Racket', brandId: addBrand('Apacs') });
    const a = addProfile({ name: 'A', recipients: ['a@x.in'] });
    const b = addProfile({ name: 'B', recipients: ['b@x.in'] });
    await stockReport.sendReport({ date: '2026-08-05', send: fakeSender().fn });

    assert.equal(stockReport.lastRun({}).length, 2);
    const onlyB = stockReport.lastRun({ profileId: b.id });
    assert.equal(onlyB.length, 1);
    assert.equal(onlyB[0].profileId, b.id);
    assert.equal(stockReport.lastRun({ profileId: a.id })[0].detail.profile, 'A');
  });
});

// ===========================================================================
// the migration that introduced profiles
// ===========================================================================

describe('migration 003: the existing setup becomes a "Default" profile', () => {
  const MIGRATIONS = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const Database = require('better-sqlite3');

  /** A fresh database with 001..003 applied and the given legacy settings. */
  function migrateWith(settings) {
    const file = path.join(TMP_DIR, `mig-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(file);
    db.exec(fs.readFileSync(path.join(MIGRATIONS, '001_init.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(MIGRATIONS, '002_phase2_assignments.sql'), 'utf8'));
    const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(settings)) insert.run(k, v);
    db.exec(fs.readFileSync(path.join(MIGRATIONS, '003_stock_report_profiles.sql'), 'utf8'));
    const rows = db.prepare('SELECT * FROM stock_report_profiles').all();
    db.close();
    return rows;
  }

  test('a configured server keeps its exact setup', () => {
    const rows = migrateWith({
      stock_report_recipients: '["a@x.in","b@x.in"]',
      stock_report_excluded_brands: '[0,7]',
      stock_report_excluded_categories: '["Fishing","CARD"]',
      stock_report_threshold: '40',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Default');
    assert.equal(rows[0].recipients_json, '["a@x.in","b@x.in"]');
    assert.equal(rows[0].excluded_brands_json, '[0,7]');
    assert.equal(rows[0].excluded_categories_json, '["Fishing","CARD"]');
    assert.equal(rows[0].threshold, 40);
    assert.equal(rows[0].enabled, 1);
  });

  test('a server that never configured the report gets no profile', () => {
    assert.deepEqual(migrateWith({ stock_report_recipients: '[]', stock_report_threshold: '25' }), []);
    assert.deepEqual(migrateWith({}), []);
  });

  test('missing or unparsable exclusions fall back rather than failing the migration', () => {
    const rows = migrateWith({
      stock_report_recipients: '["a@x.in"]',
      stock_report_excluded_brands: 'not json at all',
      stock_report_threshold: '"nonsense"',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].excluded_brands_json, '[]');
    assert.equal(rows[0].excluded_categories_json, '[]');
    assert.equal(rows[0].threshold, 25);
  });

  test('the seeded profile is readable through the normal service', () => {
    const file = path.join(TMP_DIR, `mig-read-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(file);
    db.exec(fs.readFileSync(path.join(MIGRATIONS, '001_init.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(MIGRATIONS, '002_phase2_assignments.sql'), 'utf8'));
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('stock_report_recipients', '["x@y.in"]');
    db.exec(fs.readFileSync(path.join(MIGRATIONS, '003_stock_report_profiles.sql'), 'utf8'));

    const [profile] = stockReport.listProfiles({ db });
    assert.equal(profile.name, 'Default');
    assert.deepEqual(profile.recipients, ['x@y.in']);
    assert.equal(profile.threshold, 25);
    assert.equal(profile.enabled, true);
    db.close();
  });
});

// ===========================================================================
// the HTTP surface
// ===========================================================================

describe('the stock-report HTTP routes', () => {
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
    const setCookie = res.headers.getSetCookie?.() || [];
    cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  const call = (pathname, opts = {}) =>
    fetch(origin + pathname, {
      ...opts,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
    });

  test('the file endpoint needs a session', async () => {
    const res = await fetch(`${origin}/api/stock-report/file`);
    assert.equal(res.status, 401);
  });

  test('returns the document as a download', async () => {
    addItem({ name: 'ARC ELEVEN RED', afs: 5, color: 'RED', category: 'Racket', brandId: addBrand('Apacs') });
    const res = await call('/api/stock-report/file?date=2026-08-05');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="Stock 2026-08-05\.html"/);
    const body = await res.text();
    assert.match(body, /<!doctype html>/);
    assert.match(body, /id="brandChips"/);
  });

  test('a non-numeric brand id is a 400, not a silent no-op', async () => {
    const res = await call('/api/stock-report/file?brands=Apacs');
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'invalid request');
    assert.match(JSON.stringify(json.details), /numeric brand ids/);
  });

  test('an out-of-range threshold is a 400', async () => {
    assert.equal((await call('/api/stock-report/file?threshold=0')).status, 400);
    assert.equal((await call('/api/stock-report/file?threshold=abc')).status, 400);
    assert.equal((await call('/api/stock-report/file?threshold=999999')).status, 400);
  });

  test('a malformed date is a 400', async () => {
    assert.equal((await call('/api/stock-report/file?date=05-08-2026')).status, 400);
  });

  test('the exclusions in the query actually shape the file', async () => {
    resetDb();
    const apacs = addBrand('Apacs', 1);
    const katana = addBrand('Katana', 2);
    addItem({ name: 'ARC ELEVEN RED', afs: 5, color: 'RED', category: 'Racket', brandId: apacs });
    addItem({ name: 'BLADE SEVEN BLUE', afs: 5, color: 'BLUE', category: 'Racket', brandId: katana });

    const all = await (await call('/api/stock-report/file')).text();
    assert.ok(all.includes('Katana'));

    const filtered = await (await call(`/api/stock-report/file?brands=${katana}`)).text();
    assert.ok(!filtered.includes('Katana'));
    assert.ok(filtered.includes('Apacs'));
  });

  test('a profile can be downloaded by id, and a missing one 404s', async () => {
    resetDb();
    addItem({ name: 'ARC ELEVEN RED', afs: 5, color: 'RED', category: 'Racket', brandId: addBrand('Apacs') });
    const p = addProfile({ name: 'North', recipients: ['n@x.in'], threshold: 3 });

    const res = await call(`/api/stock-report/profiles/${p.id}/file?date=2026-08-05`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /above 3 are shown/, "the profile's own threshold is used");

    assert.equal((await call('/api/stock-report/profiles/99999/file')).status, 404);
  });

  test('profiles round-trip over HTTP, and a bad address is refused', async () => {
    resetDb();
    const created = await call('/api/stock-report/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HTTP profile', recipients: ['ok@x.in'], threshold: 12 }),
    });
    assert.equal(created.status, 201);
    const { profile } = await created.json();
    assert.equal(profile.name, 'HTTP profile');
    assert.equal(profile.threshold, 12);

    const bad = await call('/api/stock-report/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', recipients: ['not-an-address'] }),
    });
    assert.equal(bad.status, 400);

    assert.equal((await call(`/api/stock-report/profiles/${profile.id}`, { method: 'DELETE' })).status, 200);
  });
});
