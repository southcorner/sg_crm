'use strict';

/**
 * Item photo thumbnails: the fetch queue, the binary client path, the
 * thumbnail pipeline, and how the cache reaches the generated stock file.
 *
 * The queue is the interesting part. It spends one API call per picture out of
 * the same daily budget as everything else, so it has to be narrow (only
 * categories where a photo helps), exact about staleness (Zoho's
 * image_document_id, not a timestamp), and resumable when the budget runs out
 * mid-drain. Every one of those is pinned here.
 *
 * Nothing in this file touches the network: the Zoho client is driven by a
 * fake fetch.
 *   npm test --workspace=server
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcrm-img-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DATA_DIR = TMP_DIR;
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';
process.env.ENABLE_CRON = 'false';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const config = require('../src/config');
const itemImages = require('../src/services/item-images');
const stockHtml = require('../src/services/stock-html');
const stockReport = require('../src/services/stock-report');
const { ZohoClient, BudgetExceededError, memoryCallCounter } = require('../src/zoho/client');

/**
 * A real 260x180 PNG on disk (flat bands + stripes, 671 bytes). A genuine
 * file rather than an inlined blob: the thumbnail pipeline has to decode real
 * PNG bytes for this suite to mean anything.
 */
const FIXTURE_PNG = fs.readFileSync(path.join(__dirname, 'fixtures', 'item-image.png'));

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function resetDb() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['item_images', 'item_brand_map', 'brands', 'items', 'sync_state', 'stock_report_profiles']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('brands','stock_report_profiles')");
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of fs.readdirSync(itemImages.cacheDir())) fs.unlinkSync(path.join(itemImages.cacheDir(), f));
}

function addBrand(name) {
  return Number(getDb().prepare('INSERT INTO brands (name, is_active) VALUES (?, 1)').run(name).lastInsertRowid);
}

let seq = 0;
function addItem({ name, category, docId = null, afs = 5, color = '', size = '', brandId = null, status = 'active' }) {
  seq += 1;
  const id = `IT${seq}`;
  const raw = {
    item_id: id,
    name,
    sku: `SK-${seq}`,
    status,
    available_for_sale: afs,
    ...(category ? { cf_item_category: category } : {}),
    ...(color ? { cf_color: color } : {}),
    ...(size ? { cf_size: size } : {}),
    ...(docId ? { image_document_id: docId, image_name: 'x.jpg', image_type: 'jpg' } : {}),
  };
  getDb()
    .prepare('INSERT INTO items (zoho_item_id, name, sku, status, raw_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, raw.sku, status, JSON.stringify(raw));
  if (brandId) {
    getDb().prepare("INSERT INTO item_brand_map (item_id, brand_id, source) VALUES (?, ?, 'manual')").run(id, brandId);
  }
  return id;
}

/** Change an item's picture the way Zoho does: a brand-new document id. */
function replacePicture(itemId, newDocId) {
  const db = getDb();
  const raw = JSON.parse(db.prepare('SELECT raw_json FROM items WHERE zoho_item_id = ?').get(itemId).raw_json);
  raw.image_document_id = newDocId;
  db.prepare('UPDATE items SET raw_json = ? WHERE zoho_item_id = ?').run(JSON.stringify(raw), itemId);
}

/**
 * A ZohoClient wired to a fake fetch. `budget` caps the in-memory counter so
 * budget exhaustion can be exercised without waiting for 2,000 calls.
 */
function fakeClient({ budget = 100, body = FIXTURE_PNG, status = 200, message = null, onCall = null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const hook = onCall ? onCall(url, calls.length) : null;
    const effective = hook || { status, body, message };
    if (effective.status !== 200) {
      return {
        status: effective.status,
        headers: { get: () => null },
        text: async () => JSON.stringify({ code: 1001, message: effective.message || 'not found' }),
      };
    }
    return {
      status: 200,
      headers: { get: (h) => (h === 'Content-Type' ? 'image/png' : null) },
      arrayBuffer: async () => effective.body.buffer.slice(effective.body.byteOffset, effective.body.byteOffset + effective.body.byteLength),
      text: async () => '',
    };
  };
  const client = new ZohoClient({
    getToken: async () => 'tok',
    getOrgId: () => '123',
    fetchImpl,
    counter: memoryCallCounter(budget),
    sleep: async () => {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  });
  return { client, calls };
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

beforeEach(() => {
  resetDb();
  config.setSetting('stock_image_categories', [...itemImages.DEFAULT_CATEGORIES]);
});

// ===========================================================================
// the binary path on the shared client
// ===========================================================================

describe('the Zoho client can fetch bytes without breaking its JSON path', () => {
  test('getBinary returns a Buffer and the content type', async () => {
    const { client, calls } = fakeClient();
    const res = await client.getBinary('/items/IT1/image');
    assert.ok(Buffer.isBuffer(res.buffer));
    assert.equal(res.buffer.length, FIXTURE_PNG.length);
    assert.deepEqual(res.buffer, FIXTURE_PNG);
    assert.equal(res.contentType, 'image/png');
    assert.match(calls[0], /\/items\/IT1\/image\?organization_id=123$/);
  });

  test('it still counts against the daily budget like any other call', async () => {
    const { client } = fakeClient({ budget: 3 });
    assert.equal(client.budgetStatus().used, 0);
    await client.getBinary('/items/IT1/image');
    await client.getBinary('/items/IT2/image');
    assert.equal(client.budgetStatus().used, 2);
  });

  test('the budget still throws when spent', async () => {
    const { client } = fakeClient({ budget: 1 });
    await client.getBinary('/items/IT1/image');
    await assert.rejects(() => client.getBinary('/items/IT2/image'), BudgetExceededError);
  });

  test('an error status still decodes as JSON, not as bytes', async () => {
    const { client } = fakeClient({ status: 404, message: 'no image' });
    await assert.rejects(() => client.getBinary('/items/IT1/image'), (err) => {
      assert.equal(err.status, 404);
      assert.match(err.message, /no image/);
      return true;
    });
  });

  test('the ordinary JSON path is untouched', async () => {
    const client = new ZohoClient({
      getToken: async () => 'tok',
      getOrgId: () => '123',
      fetchImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => '{"items":[{"item_id":"A"}]}' }),
      counter: memoryCallCounter(10),
      sleep: async () => {},
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    });
    assert.deepEqual(await client.get('/items'), { items: [{ item_id: 'A' }] });
  });
});

// ===========================================================================
// the thumbnail pipeline
// ===========================================================================

describe('thumbnails', () => {
  test('a real PNG becomes a small valid JPEG within 128px', async () => {
    const thumb = await itemImages.makeThumbnail(FIXTURE_PNG);
    assert.ok(Buffer.isBuffer(thumb.buffer));
    assert.ok(thumb.buffer.length < 15000, `expected < 15 KB, got ${thumb.buffer.length}`);
    // JPEG start-of-image and end-of-image markers
    assert.equal(thumb.buffer[0], 0xff);
    assert.equal(thumb.buffer[1], 0xd8);
    assert.equal(thumb.buffer[thumb.buffer.length - 2], 0xff);
    assert.equal(thumb.buffer[thumb.buffer.length - 1], 0xd9);
    assert.ok(Math.max(thumb.width, thumb.height) <= itemImages.MAX_EDGE);
    // 260x180 into a 128 box keeps its aspect ratio (180 * 128/260 = 88.6)
    assert.equal(thumb.width, 128);
    assert.equal(thumb.height, 89);
  });

  test('it never upscales a picture that is already small', async () => {
    const { Jimp } = require('jimp');
    const small = await new Jimp({ width: 40, height: 30, color: 0x00ff00ff }).getBuffer('image/png');
    const thumb = await itemImages.makeThumbnail(small);
    assert.equal(thumb.width, 40);
    assert.equal(thumb.height, 30);
  });

  test('junk bytes are rejected rather than written as a broken file', async () => {
    await assert.rejects(() => itemImages.makeThumbnail(Buffer.from('this is not an image')));
  });
});

// ===========================================================================
// scope
// ===========================================================================

describe('scope: only categories where a photo helps', () => {
  beforeEach(() => {
    const brand = addBrand('Apacs');
    addItem({ name: 'JERSEY ONE', category: 'Badminton Jersey', docId: 'D1', brandId: brand });
    addItem({ name: 'SHOE ONE', category: 'Shoes', docId: 'D2', brandId: brand });
    addItem({ name: 'RACKET ONE', category: 'Racket', docId: 'D3', brandId: brand });
    addItem({ name: 'JERSEY NO PICTURE', category: 'Badminton Jersey', brandId: brand });
    addItem({ name: 'INACTIVE JERSEY', category: 'Badminton Jersey', docId: 'D4', status: 'inactive', brandId: brand });
  });

  test('a racket with a picture is never queued', () => {
    const names = pendingNames();
    assert.ok(names.includes('JERSEY ONE'));
    assert.ok(names.includes('SHOE ONE'));
    assert.ok(!names.includes('RACKET ONE'), 'a racket is identified by its model name, not its photo');
  });

  test('an item with no picture is not queued', () => {
    assert.ok(!pendingNames().includes('JERSEY NO PICTURE'));
  });

  test('an inactive item is not queued', () => {
    assert.ok(!pendingNames().includes('INACTIVE JERSEY'));
  });

  test('narrowing the category setting narrows the queue', () => {
    config.setSetting('stock_image_categories', ['Shoes']);
    assert.deepEqual(pendingNames(), ['SHOE ONE']);
  });

  test('an empty category list switches the whole feature off', async () => {
    config.setSetting('stock_image_categories', []);
    assert.deepEqual(itemImages.pendingImages({}), []);
    const { client, calls } = fakeClient();
    const res = await itemImages.syncItemImages({ client, limit: 10 });
    assert.equal(calls.length, 0);
    assert.match(res.skipped, /no categories/);
  });

  test('progress counts what is in scope', () => {
    const p = itemImages.imageProgress({});
    assert.equal(p.inScope, 2);
    assert.equal(p.pending, 2);
    assert.equal(p.cached, 0);
  });
});

function pendingNames() {
  const db = getDb();
  return itemImages
    .pendingImages({})
    .map((r) => db.prepare('SELECT name FROM items WHERE zoho_item_id = ?').get(r.item_id).name);
}

// ===========================================================================
// the queue
// ===========================================================================

describe('the image queue', () => {
  let jersey;

  beforeEach(() => {
    const brand = addBrand('Apacs');
    jersey = addItem({ name: 'JERSEY ONE', category: 'Badminton Jersey', docId: 'DOC-1', brandId: brand });
    addItem({ name: 'JERSEY TWO', category: 'Badminton Jersey', docId: 'DOC-2', brandId: brand });
  });

  test('a first pass fetches, thumbnails and records both', async () => {
    const { client, calls } = fakeClient();
    const res = await itemImages.syncItemImages({ client, limit: 10 });

    assert.equal(res.processed, 2);
    assert.equal(res.failed, 0);
    assert.equal(res.pending, 0);
    assert.equal(calls.length, 2);

    const rows = getDb().prepare('SELECT * FROM item_images ORDER BY item_id').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === 'ok' && r.bytes > 0 && r.file));
    // the thumbnail really is on disk
    assert.ok(rows.every((r) => fs.existsSync(itemImages.cachePath(r.file))));
  });

  test('a second pass fetches nothing — the doc ids are unchanged', async () => {
    await itemImages.syncItemImages({ client: fakeClient().client, limit: 10 });
    const second = fakeClient();
    const res = await itemImages.syncItemImages({ client: second.client, limit: 10 });
    assert.equal(second.calls.length, 0);
    assert.equal(res.processed, 0);
    assert.equal(res.pending, 0);
  });

  test('a replaced picture (new doc id) is re-fetched, and the old file is swept', async () => {
    await itemImages.syncItemImages({ client: fakeClient().client, limit: 10 });
    const oldFile = getDb().prepare('SELECT file FROM item_images WHERE item_id = ?').get(jersey).file;
    assert.ok(fs.existsSync(itemImages.cachePath(oldFile)));

    replacePicture(jersey, 'DOC-1-NEW');
    assert.deepEqual(itemImages.pendingImages({}).map((r) => r.item_id), [jersey]);

    const again = fakeClient();
    const res = await itemImages.syncItemImages({ client: again.client, limit: 10 });
    assert.equal(res.processed, 1);
    assert.equal(again.calls.length, 1);

    const row = getDb().prepare('SELECT * FROM item_images WHERE item_id = ?').get(jersey);
    assert.equal(row.doc_id, 'DOC-1-NEW');
    assert.notEqual(row.file, oldFile);
    assert.ok(fs.existsSync(itemImages.cachePath(row.file)));
    assert.ok(!fs.existsSync(itemImages.cachePath(oldFile)), 'the superseded thumbnail is deleted');
  });

  test('a 404 is recorded as missing and never retried', async () => {
    const { client, calls } = fakeClient({ status: 404, message: 'image not found' });
    const res = await itemImages.syncItemImages({ client, limit: 10 });
    assert.equal(res.missing, 2);
    assert.equal(res.processed, 0);
    assert.equal(calls.length, 2);

    const second = fakeClient();
    await itemImages.syncItemImages({ client: second.client, limit: 10 });
    assert.equal(second.calls.length, 0, 'Zoho already said there is no picture there');
  });

  test('a replaced picture re-queues even an item previously marked missing', async () => {
    await itemImages.syncItemImages({ client: fakeClient({ status: 404 }).client, limit: 10 });
    replacePicture(jersey, 'DOC-1-NEW');
    const again = fakeClient();
    const res = await itemImages.syncItemImages({ client: again.client, limit: 10 });
    assert.equal(res.processed, 1);
    assert.equal(again.calls.length, 1);
  });

  test('the batch limit leaves the rest pending and resumable', async () => {
    const first = fakeClient();
    const res = await itemImages.syncItemImages({ client: first.client, limit: 1 });
    assert.equal(res.processed, 1);
    assert.equal(res.pending, 1);
    assert.equal(first.calls.length, 1);

    const second = fakeClient();
    const res2 = await itemImages.syncItemImages({ client: second.client, limit: 10 });
    assert.equal(res2.processed, 1);
    assert.equal(res2.pending, 0);
  });

  test('an exhausted budget halts cleanly and resumes next time', async () => {
    // budget of 1: the first fetch succeeds, the second throws BudgetExceeded
    const { client, calls } = fakeClient({ budget: 1 });
    const res = await itemImages.syncItemImages({ client, limit: 10 });

    assert.equal(res.processed, 1);
    assert.equal(res.pending, 1);
    assert.equal(calls.length, 1);
    assert.equal(res.halted, true, 'work left and nothing to spend is a halt, not a clean finish');

    const state = getDb().prepare("SELECT * FROM sync_state WHERE entity = 'item_images'").get();
    assert.equal(state.last_status, 'halted');
    assert.match(state.last_error, /budget/i);
    assert.equal(state.total_pending, 1);

    // tomorrow, with budget again
    const fresh = fakeClient({ budget: 100 });
    const res2 = await itemImages.syncItemImages({ client: fresh.client, limit: 10 });
    assert.equal(res2.processed, 1);
    assert.equal(res2.pending, 0);
    assert.equal(getDb().prepare("SELECT last_status FROM sync_state WHERE entity = 'item_images'").get().last_status, 'ok');
  });

  test('no budget left at all is a halt before any call', async () => {
    const { client, calls } = fakeClient({ budget: 0 });
    const res = await itemImages.syncItemImages({ client, limit: 10 });
    assert.equal(calls.length, 0);
    assert.equal(res.processed, 0);
    assert.equal(res.halted, true);
  });

  test('a transient failure is recorded and retried next pass', async () => {
    const { client } = fakeClient({ onCall: () => ({ status: 500, message: 'boom' }) });
    const res = await itemImages.syncItemImages({ client, limit: 10 });
    assert.equal(res.failed, 2);
    assert.equal(getDb().prepare("SELECT COUNT(*) n FROM item_images WHERE status = 'error'").get().n, 2);

    const good = fakeClient();
    const res2 = await itemImages.syncItemImages({ client: good.client, limit: 10 });
    assert.equal(res2.processed, 2, 'an errored row is still pending');
  });

  test('pruning drops rows for items that left scope', async () => {
    await itemImages.syncItemImages({ client: fakeClient().client, limit: 10 });
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM item_images').get().n, 2);

    config.setSetting('stock_image_categories', ['Shoes']);
    const { pruned } = itemImages.pruneCache({});
    assert.equal(pruned, 2);
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM item_images').get().n, 0);
    assert.equal(fs.readdirSync(itemImages.cacheDir()).length, 0);
  });
});

// ===========================================================================
// reaching the generated file
// ===========================================================================

describe('thumbnails in the stock file', () => {
  beforeEach(async () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'JERSEY RED', category: 'Badminton Jersey', docId: 'D1', color: 'RED', size: 'M', afs: 5, brandId: brand });
    addItem({ name: 'RACKET ONE', category: 'Racket', color: 'BLACK', afs: 5, brandId: brand });
    await itemImages.syncItemImages({ client: fakeClient().client, limit: 10 });
  });

  test('a cached picture is embedded as a data URI', () => {
    const file = stockHtml.generate({ date: '2026-08-05' });
    assert.equal(file.images, 1);
    assert.match(file.html, /data:image\/jpeg;base64,/);
    assert.equal(file.includeImages, true);
  });

  test('includeImages:false emits no image data at all', () => {
    const file = stockHtml.generate({ date: '2026-08-05', includeImages: false });
    assert.equal(file.images, 0);
    assert.ok(!file.html.includes('data:image/jpeg'));
    assert.ok(!file.html.includes('data:image'));
  });

  test('a model with no cached picture just has no image — no placeholder', () => {
    const tree = require('../src/services/stock').buildStock({});
    const thumbs = itemImages.loadThumbnails({});
    const index = stockHtml.makeImageIndex(thumbs);
    const rows = stockHtml.buildRows(tree, 25, index);

    const racket = rows.find((r) => r.c === 'Racket');
    assert.ok(racket.v.every((v) => v.i === undefined), 'no image key at all, not a null');
  });

  test('identical pictures are stored once and referenced by index', async () => {
    // three more jerseys, all with the SAME picture bytes
    const brand = getDb().prepare("SELECT id FROM brands WHERE name = 'Apacs'").get().id;
    addItem({ name: 'JERSEY BLUE', category: 'Badminton Jersey', docId: 'D9', color: 'BLUE', size: 'L', brandId: brand });
    addItem({ name: 'JERSEY GREEN', category: 'Badminton Jersey', docId: 'D10', color: 'GREEN', size: 'XL', brandId: brand });
    await itemImages.syncItemImages({ client: fakeClient().client, limit: 10 });

    const file = stockHtml.generate({ date: '2026-08-05' });
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM item_images').get().n, 3);
    assert.equal(file.images, 1, 'three items, one distinct picture, one entry');
  });

  test('a broken cache file degrades to no image rather than failing the file', () => {
    const row = getDb().prepare('SELECT file FROM item_images LIMIT 1').get();
    fs.unlinkSync(itemImages.cachePath(row.file));
    const file = stockHtml.generate({ date: '2026-08-05' });
    assert.equal(file.images, 0);
    assert.match(file.html, /<!doctype html>/);
  });
});

// ===========================================================================
// the size guardrail
// ===========================================================================

describe('the attachment size guardrail', () => {
  beforeEach(async () => {
    const brand = addBrand('Apacs');
    addItem({ name: 'JERSEY RED', category: 'Badminton Jersey', docId: 'D1', color: 'RED', size: 'M', brandId: brand });
    await itemImages.syncItemImages({ client: fakeClient().client, limit: 10 });
    config.setSetting('stock_report_enabled', true);
  });

  test('under the cap the images stay', () => {
    const profile = stockReport.createProfile({ name: 'Pics', recipients: ['a@x.in'] }, {});
    const report = stockReport.compose({ profile, date: '2026-08-05' });
    assert.equal(report.includeImages, true);
    assert.equal(report.imagesDropped, null);
    assert.match(report.attachment.content, /data:image\/jpeg/);
  });

  test('over the cap the images are dropped and the send still happens', () => {
    // a cap of 1 KB is unreachable with images and reachable without
    config.setSetting('stock_max_attachment_bytes', 1024);
    const profile = stockReport.createProfile({ name: 'Pics', recipients: ['a@x.in'] }, {});
    const report = stockReport.compose({ profile, date: '2026-08-05' });

    assert.equal(report.includeImages, false);
    assert.equal(report.imagesDropped.reason, 'size');
    assert.ok(report.imagesDropped.bytesWithImages > 1024);
    assert.equal(report.imagesDropped.cap, 1024);
    assert.ok(!report.attachment.content.includes('data:image'));
    assert.match(report.attachment.content, /<!doctype html>/, 'the file itself still went out');

    config.setSetting('stock_max_attachment_bytes', stockReport.DEFAULT_MAX_ATTACHMENT_BYTES);
  });

  test('a profile with include_images off never generates them in the first place', () => {
    const profile = stockReport.createProfile({ name: 'Lean', recipients: ['a@x.in'], includeImages: false }, {});
    assert.equal(profile.includeImages, false);
    const report = stockReport.compose({ profile, date: '2026-08-05' });
    assert.equal(report.includeImages, false);
    assert.equal(report.imagesDropped, null, 'switched off, not dropped for size');
    assert.ok(!report.attachment.content.includes('data:image'));
  });

  test('include_images round-trips through profile CRUD and defaults on', () => {
    const on = stockReport.createProfile({ name: 'A', recipients: ['a@x.in'] }, {});
    assert.equal(on.includeImages, true);
    const off = stockReport.updateProfile(on.id, { includeImages: false }, {});
    assert.equal(off.includeImages, false);
    assert.equal(stockReport.updateProfile(on.id, { threshold: 9 }, {}).includeImages, false, 'untouched by other edits');
    assert.equal(stockReport.updateProfile(on.id, { includeImages: true }, {}).includeImages, true);
  });
});
