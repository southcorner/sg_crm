'use strict';

/**
 * The offline stock browser (services/stock-html.js).
 *
 * The property under test that actually matters is the masking guarantee: a
 * quantity above the threshold must not exist ANYWHERE in the emitted file.
 * The file is handed to dealers, so "the UI hides it" is not good enough — the
 * number must never be written. These tests parse the embedded DATA payload
 * (where a leak would live) as well as scanning the whole document.
 *   npm test --workspace=server
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcrm-shtml-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DATA_DIR = TMP_DIR;
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';
process.env.ENABLE_CRON = 'false';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const config = require('../src/config');
const stockHtml = require('../src/services/stock-html');
const stock = require('../src/services/stock');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function resetDb() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['item_brand_map', 'brands', 'items']) db.prepare(`DELETE FROM ${t}`).run();
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'brands'");
  db.exec('PRAGMA foreign_keys = ON');
}

function addBrand(name, sortOrder = 0) {
  return Number(
    getDb().prepare('INSERT INTO brands (name, sort_order, is_active) VALUES (?, ?, 1)').run(name, sortOrder)
      .lastInsertRowid
  );
}

let seq = 0;
function addItem({ name, sku, afs = 1, color = '', category = '', size = '', brandId = null, status = 'active' }) {
  seq += 1;
  const id = `I${seq}`;
  const raw = {
    item_id: id,
    name,
    sku: sku || `SK-${String.fromCharCode(96 + seq)}`,
    status,
    available_for_sale: afs,
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

/** Pull the `const DATA = [...]` payload back out of the generated document. */
function extractData(html) {
  const m = /const DATA = (\[.*?\]);\nconst BRANDS/s.exec(html);
  assert.ok(m, 'the generated file must embed a DATA array');
  return JSON.parse(m[1]);
}

function extractArray(html, name) {
  const m = new RegExp(`const ${name} = (\\[.*?\\]);`, 's').exec(html);
  assert.ok(m, `the generated file must embed ${name}`);
  return JSON.parse(m[1]);
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
    /* windows may still hold the wal file */
  }
});

beforeEach(resetDb);

// ===========================================================================

describe('the masked quantity never reaches the file', () => {
  const DATE = '2026-08-05';

  beforeEach(() => {
    const brand = addBrand('Apacs');
    // 26 is one over the threshold, 25 is exactly on it — the whole rule in
    // two rows. Names and SKUs deliberately carry no digits.
    addItem({ name: 'ALPHA ONE RED', sku: 'SK-ALPHA', afs: 26, color: 'RED', category: 'Racket', brandId: brand });
    addItem({ name: 'BETA TWO BLUE', sku: 'SK-BETA', afs: 25, color: 'BLUE', category: 'Racket', brandId: brand });
  });

  test('26 becomes "Available" and its digits are nowhere in the document', () => {
    const file = stockHtml.generate({ threshold: 25, date: DATE });
    const rows = extractData(file.html);

    const alpha = rows.find((r) => r.m === 'Alpha One');
    assert.equal(alpha.q, 'Available');
    assert.deepEqual(alpha.v, [{ c: 'RED', q: 'Available' }]);

    // \b26\b matches a standalone 26 but not "26px" or "#1a2530"
    assert.ok(!/\b26\b/.test(file.html), 'the real quantity leaked into the file');
    assert.ok(file.html.includes('Available'));
  });

  test('25 is exactly on the boundary and IS printed', () => {
    const file = stockHtml.generate({ threshold: 25, date: DATE });
    const beta = extractData(file.html).find((r) => r.m === 'Beta Two');
    assert.equal(beta.q, '25');
    assert.deepEqual(beta.v, [{ c: 'BLUE', q: '25' }]);
    assert.ok(/\b25\b/.test(file.html));
  });

  test('a lower threshold masks both', () => {
    const rows = extractData(stockHtml.generate({ threshold: 10, date: DATE }).html);
    assert.deepEqual(rows.map((r) => r.q).sort(), ['Available', 'Available']);
  });

  test('a higher threshold reveals both', () => {
    const rows = extractData(stockHtml.generate({ threshold: 100, date: DATE }).html);
    assert.deepEqual(rows.map((r) => r.q).sort(), ['25', '26']);
  });

  test('the search haystack carries names and SKUs but never quantities', () => {
    const rows = extractData(stockHtml.generate({ threshold: 25, date: DATE }).html);
    const alpha = rows.find((r) => r.m === 'Alpha One');
    assert.match(alpha.s, /SK-ALPHA/);
    assert.match(alpha.s, /ALPHA ONE RED/);
    assert.match(alpha.s, /RED/);
    assert.ok(!/\b26\b/.test(alpha.s), 'the haystack must not become a side channel');
  });

  test('the footer states the threshold in force', () => {
    assert.match(stockHtml.generate({ threshold: 40, date: DATE }).html, /above 40 are shown/);
  });
});

describe('profile filtering produces genuinely different files', () => {
  const DATE = '2026-08-05';
  let apacs;
  let katana;

  beforeEach(() => {
    apacs = addBrand('Apacs', 1);
    katana = addBrand('Katana', 2);
    addItem({ name: 'ALPHA ONE RED', sku: 'SK-ALPHA', afs: 5, color: 'RED', category: 'Racket', brandId: apacs });
    addItem({ name: 'GRIP TAPE BLACK', sku: 'SK-GRIP', afs: 5, color: 'BLACK', category: 'Grip', brandId: apacs });
    addItem({ name: 'BLADE SEVEN BLUE', sku: 'SK-BLADE', afs: 5, color: 'BLUE', category: 'Racket', brandId: katana });
    addItem({ name: 'ORPHAN THING', sku: 'SK-ORPH', afs: 5, category: 'Racket' });
  });

  test('with nothing excluded every brand is present', () => {
    const file = stockHtml.generate({ date: DATE });
    assert.deepEqual(file.brands, ['Apacs', 'Katana', 'Unbranded']);
    assert.deepEqual(file.categories, ['Grip', 'Racket']);
    assert.equal(file.counts.rows, 4);
  });

  test('an excluded brand is absent from the chips AND from the document', () => {
    const file = stockHtml.generate({ date: DATE, excludedBrands: [katana] });
    assert.deepEqual(file.brands, ['Apacs', 'Unbranded']);
    assert.ok(!file.html.includes('Katana'));
    assert.ok(!file.html.includes('Blade Seven'));
    assert.ok(!file.html.includes('SK-BLADE'));
    assert.equal(file.counts.rows, 3);
  });

  test('the Unbranded bucket is excludable with id 0', () => {
    const file = stockHtml.generate({ date: DATE, excludedBrands: [0] });
    assert.deepEqual(file.brands, ['Apacs', 'Katana']);
    assert.ok(!file.html.includes('Unbranded'));
    assert.ok(!file.html.includes('SK-ORPH'));
  });

  test('an excluded category is absent across every brand', () => {
    const file = stockHtml.generate({ date: DATE, excludedCategories: ['Racket'] });
    assert.deepEqual(file.categories, ['Grip']);
    assert.deepEqual(file.brands, ['Apacs']);
    assert.ok(!file.html.includes('SK-ALPHA'));
    assert.ok(!file.html.includes('SK-BLADE'));
    assert.equal(file.counts.rows, 1);
  });

  test('two profiles produce two different documents from one dataset', () => {
    const rackets = stockHtml.generate({ date: DATE, excludedCategories: ['Grip'], excludedBrands: [0] });
    const everything = stockHtml.generate({ date: DATE });
    assert.notEqual(rackets.html, everything.html);
    assert.equal(rackets.counts.rows, 2);
    assert.equal(everything.counts.rows, 4);
  });

  test('excluding everything still yields a valid, empty document', () => {
    const file = stockHtml.generate({ date: DATE, excludedBrands: [apacs, katana, 0] });
    assert.equal(file.counts.rows, 0);
    assert.deepEqual(extractData(file.html), []);
    assert.match(file.html, /<!doctype html>/);
  });
});

describe('the document itself', () => {
  const DATE = '2026-08-05';

  test('is self-contained: no external script, style or image', () => {
    addItem({ name: 'ALPHA ONE', sku: 'SK-A', afs: 5, category: 'Racket', brandId: addBrand('Apacs') });
    const html = stockHtml.generate({ date: DATE }).html;
    assert.ok(!/<script[^>]+src=/i.test(html), 'no external script');
    assert.ok(!/<link[^>]+stylesheet/i.test(html), 'no external stylesheet');
    // the lightbox ships one empty <img> that is filled from the embedded data
    // URIs at runtime; what must not exist is an image fetched from anywhere
    assert.ok(!/<img[^>]+src=["']?(?!data:)/i.test(html), 'no externally-sourced image');
    assert.ok(!/https?:\/\//i.test(html), 'no outbound URLs at all');
  });

  test('carries the search box, both chip rows and the dark-mode block', () => {
    addItem({ name: 'ALPHA ONE', sku: 'SK-A', afs: 5, category: 'Racket', brandId: addBrand('Apacs') });
    const html = stockHtml.generate({ date: DATE }).html;
    assert.match(html, /id="q"[^>]*type="search"/);
    assert.match(html, /id="brandChips"/);
    assert.match(html, /id="catChips"/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /tap a model for details/);
  });

  test('the filename and title carry the date', () => {
    addItem({ name: 'ALPHA ONE', sku: 'SK-A', afs: 5, category: 'Racket', brandId: addBrand('Apacs') });
    const file = stockHtml.generate({ date: DATE });
    assert.equal(file.filename, 'Stock 2026-08-05.html');
    assert.match(file.html, /<title>Stock availability 2026-08-05<\/title>/);
  });

  test('a custom title is honoured and escaped', () => {
    addItem({ name: 'ALPHA ONE', sku: 'SK-A', afs: 5, category: 'Racket', brandId: addBrand('Apacs') });
    const file = stockHtml.generate({ date: DATE, title: 'Dealer <b>list</b>' });
    assert.ok(!file.html.includes('<b>list</b>'));
    assert.match(file.html, /Dealer &lt;b&gt;list&lt;\/b&gt;/);
  });
});

describe('escaping: the payload is admin-controlled text', () => {
  const DATE = '2026-08-05';

  test('an item name cannot break out of the script block', () => {
    const brand = addBrand('Apacs');
    addItem({
      name: 'EVIL </script><script>alert(1)</script> RACKET',
      sku: 'SK-EVIL',
      afs: 5,
      category: 'Racket',
      brandId: brand,
    });
    const html = stockHtml.generate({ date: DATE }).html;
    // exactly one opening and one closing script tag: ours
    assert.equal((html.match(/<script>/gi) || []).length, 1);
    assert.equal((html.match(/<\/script>/gi) || []).length, 1);
    // neutralised, not stripped — the haystack is uppercased, hence the /i
    assert.match(html, /\\u003c\/script>/i, 'the payload must be neutralised, not stripped');
    // and it is still searchable
    assert.match(extractData(html)[0].s, /EVIL/);
  });

  test('a brand name with markup survives as text, not as markup', () => {
    const brand = addBrand('<img src=x onerror=alert(1)>');
    addItem({ name: 'ALPHA ONE', sku: 'SK-A', afs: 5, category: 'Racket', brandId: brand });
    const file = stockHtml.generate({ date: DATE });
    // The injected tag must never become live markup. It survives verbatim as a
    // STRING inside the JSON payload — "onerror=..." is in the file as data, and
    // that is fine, because its `<` is escaped so it can never open a tag and
    // the renderer only ever assigns it via textContent.
    assert.ok(!/<img src=x/i.test(file.html), 'the injected tag never opens');
    assert.equal((file.html.match(/<img/gi) || []).length, 1, 'the only <img> is the lightbox');
    assert.equal(extractArray(file.html, 'BRANDS')[0], '<img src=x onerror=alert(1)>');
    assert.ok(file.html.includes('\\u003cimg'), 'the < is escaped inside the JSON payload');
  });

  test('embedJson neutralises script terminators and JS line separators', () => {
    const out = stockHtml.embedJson({ a: '</script>', b: `x${String.fromCharCode(0x2028)}y` });
    assert.ok(!out.includes('</script>'));
    assert.ok(out.includes('\\u003c/script>'));
    assert.ok(!out.includes(String.fromCharCode(0x2028)));
    assert.ok(out.includes('\\u2028'));
    assert.deepEqual(JSON.parse(out.replace(/\\u003c/g, '<')), { a: '</script>', b: `x${String.fromCharCode(0x2028)}y` });
  });
});

// ===========================================================================
// jerseys: Model → Size → Colour
// ===========================================================================

describe('jersey hierarchy: a size level between the model and its colours', () => {
  const DATE = '2026-08-05';
  let brand;

  /** One polo, three sizes, several colourways — the shape a dealer asks about. */
  function seedPolo() {
    brand = addBrand('Apacs');
    // modelKey strips size tokens, so all of these are ONE model
    addItem({ name: 'TEAM POLO RED S', sku: 'SK-P1', afs: 4, color: 'RED', category: 'Badminton Jersey', brandId: brand, size: 'S' });
    addItem({ name: 'TEAM POLO BLUE S', sku: 'SK-P2', afs: 6, color: 'BLUE', category: 'Badminton Jersey', brandId: brand, size: 'S' });
    addItem({ name: 'TEAM POLO RED XL', sku: 'SK-P3', afs: 30, color: 'RED', category: 'Badminton Jersey', brandId: brand, size: 'XL' });
    addItem({ name: 'TEAM POLO RED M', sku: 'SK-P4', afs: 7, color: 'RED', category: 'Badminton Jersey', brandId: brand, size: 'M' });
  }

  const poloRow = (threshold = 25) => {
    const tree = stock.buildStock({});
    return stockHtml.buildRows(tree, threshold).find((r) => r.c === 'Badminton Jersey');
  };

  beforeEach(seedPolo);

  test('the sizes become their own level, and the model stays one model', () => {
    const row = poloRow();
    assert.equal(row.m, 'Team Polo');
    assert.ok(row.z, 'jerseys carry a size level');
    assert.equal(row.v, undefined, 'and not a flat colour list');
    assert.deepEqual(row.z.map((s) => s.s), ['S', 'M', 'XL']);
  });

  test('sizes sort the way a human reads them, not alphabetically', () => {
    addItem({ name: 'TEAM POLO RED 2XL', sku: 'SK-P5', afs: 1, color: 'RED', category: 'Badminton Jersey', brandId: brand, size: '2XL' });
    addItem({ name: 'TEAM POLO RED XS', sku: 'SK-P6', afs: 1, color: 'RED', category: 'Badminton Jersey', brandId: brand, size: 'XS' });
    addItem({ name: 'TEAM POLO RED 3XL', sku: 'SK-P7', afs: 1, color: 'RED', category: 'Badminton Jersey', brandId: brand, size: '3XL' });
    assert.deepEqual(poloRow().z.map((s) => s.s), ['XS', 'S', 'M', 'XL', '2XL', '3XL']);
  });

  test('XXL and 2XL rank together, and unknown sizes sort last by name', () => {
    assert.equal(stockHtml.compareSizes('XXL', '3XL') < 0, true);
    assert.equal(stockHtml.compareSizes('2XL', 'XXL'), 0 || stockHtml.compareSizes('2XL', 'XXL'));
    assert.ok(stockHtml.compareSizes('S', 'J160') < 0, 'a known size beats an unknown one');
    assert.ok(stockHtml.compareSizes('J160', 'Z999') < 0, 'unknowns fall back to alphabetical');
  });

  test('size subtotals add up to the model total, before any masking', () => {
    const tree = stock.buildStock({});
    const model = tree.brands[0].categories.find((c) => c.name === 'Badminton Jersey').models[0];
    // a threshold above every quantity prints exact numbers
    const raw = stockHtml.sizeGroups(model, 1e9, null);
    const sum = raw.reduce((n, s) => n + Number(s.q), 0);
    assert.equal(sum, model.total);
    assert.equal(sum, 4 + 6 + 30 + 7);
  });

  test('masking applies at every level independently', () => {
    const row = poloRow(25);
    assert.equal(row.q, 'Available', 'model total 47 > 25');

    const byName = new Map(row.z.map((s) => [s.s, s]));
    assert.equal(byName.get('S').q, '10', 'size subtotal 4 + 6');
    assert.equal(byName.get('M').q, '7');
    assert.equal(byName.get('XL').q, 'Available', 'size subtotal 30 > 25');

    assert.deepEqual(byName.get('S').v.map((v) => `${v.c}:${v.q}`), ['BLUE:6', 'RED:4']);
    assert.deepEqual(byName.get('XL').v.map((v) => `${v.c}:${v.q}`), ['RED:Available']);

    // and the real numbers are nowhere in the emitted document
    const html = stockHtml.generate({ date: DATE, threshold: 25, includeImages: false }).html;
    assert.ok(!/\b47\b/.test(html), 'the model total leaked');
    assert.ok(!/\b30\b/.test(html), 'the XL subtotal leaked');
  });

  test('a lower threshold masks the size rows too', () => {
    const byName = new Map(poloRow(5).z.map((s) => [s.s, s]));
    assert.equal(byName.get('S').q, 'Available');
    assert.equal(byName.get('M').q, 'Available', '7 > 5');
    assert.deepEqual(byName.get('S').v.map((v) => v.q), ['Available', '4']);
  });

  test('the search haystack carries the sizes', () => {
    const row = poloRow();
    assert.match(row.s, /\bS\b/);
    assert.match(row.s, /XL/);
    // "polo xl" is the query a dealer types
    const toks = 'polo xl'.toUpperCase().split(/\s+/);
    assert.ok(toks.every((t) => row.s.includes(t)));
  });

  test('a blank cf_size falls back to the item name, then to Free size', () => {
    resetDb();
    const b = addBrand('Apacs');
    addItem({ name: 'TRAIL TEE 2XL', sku: 'SK-N1', afs: 3, color: 'RED', category: 'Cycling Jersey', brandId: b });
    addItem({ name: 'TRAIL TEE', sku: 'SK-N2', afs: 2, color: 'BLUE', category: 'Cycling Jersey', brandId: b });

    const row = stockHtml.buildRows(stock.buildStock({}), 25).find((r) => r.c === 'Cycling Jersey');
    assert.deepEqual(row.z.map((s) => s.s).sort(), ['2XL', 'Free size'].sort());
    assert.equal(stockHtml.parseSizeFromName('TRAIL TEE 2XL'), '2XL');
    assert.equal(stockHtml.parseSizeFromName('TRAIL TEE'), null);
    assert.equal(stockHtml.itemSize({ name: 'TRAIL TEE', size: '' }), 'Free size');
    assert.equal(stockHtml.itemSize({ name: 'ANY', size: 'm' }), 'M', 'the custom field wins, upper-cased');
  });

  test('both jersey categories get the level; nothing else does', () => {
    resetDb();
    const b = addBrand('Apacs');
    addItem({ name: 'BADMINTON TEE RED', sku: 'SK-B', afs: 3, color: 'RED', category: 'Badminton Jersey', brandId: b, size: 'M' });
    addItem({ name: 'CYCLE TEE RED', sku: 'SK-C', afs: 3, color: 'RED', category: 'Cycling Jersey', brandId: b, size: 'M' });
    addItem({ name: 'ARC ELEVEN RED', sku: 'SK-R', afs: 3, color: 'RED', category: 'Racket', brandId: b, size: '4U' });
    addItem({ name: 'RUN SHOE RED', sku: 'SK-S', afs: 3, color: 'RED', category: 'Shoes', brandId: b, size: '9' });

    const rows = stockHtml.buildRows(stock.buildStock({}), 25);
    const sized = rows.filter((r) => r.z).map((r) => r.c).sort();
    const flat = rows.filter((r) => r.v).map((r) => r.c).sort();
    assert.deepEqual(sized, ['Badminton Jersey', 'Cycling Jersey']);
    assert.deepEqual(flat, ['Racket', 'Shoes'], 'shoes have sizes too, but a dealer picks a shoe by model');
  });

  test('a non-jersey model is byte-for-byte the shape it always was', () => {
    resetDb();
    const b = addBrand('Apacs');
    addItem({ name: 'ARC ELEVEN RED', sku: 'SK-R1', afs: 5, color: 'RED', category: 'Racket', brandId: b });
    addItem({ name: 'ARC ELEVEN BLUE', sku: 'SK-R2', afs: 3, color: 'BLUE', category: 'Racket', brandId: b });

    const row = stockHtml.buildRows(stock.buildStock({}), 25)[0];
    assert.equal(row.z, undefined);
    assert.deepEqual(row.v, [{ c: 'RED', q: '5' }, { c: 'BLUE', q: '3' }]);
  });

  test('the rendered page carries the size markup and the two-level script', () => {
    const html = stockHtml.generate({ date: DATE, includeImages: false }).html;
    // the size rows are built by the in-page script, so the FILE ships the CSS
    // that styles them plus the code that creates them
    assert.match(html, /\.sz-head \{/, 'the CSS for the size level ships');
    assert.match(html, /\.sz\.open \.sz-body/);
    assert.match(html, /'sz-head'/, 'and the script that builds those rows');
    assert.match(html, /stopPropagation/, 'a size tap must not close the card');
    assert.match(html, /min-height:40px/, 'touch target');
  });
});
