'use strict';

/**
 * Item photo thumbnails for the dealer stock file.
 *
 * Zoho serves an item's picture from `GET /items/{id}/image` — one API call
 * each, against the same daily budget as every other request. So images are
 * cached, and the cache is deliberately narrow:
 *
 *   * only categories where a picture actually helps a dealer choose
 *     (`stock_image_categories`: jerseys, shoes, string, grip — a racket is
 *     identified by its model name, not its photo);
 *   * only items that HAVE a picture (`image_document_id` in the payload);
 *   * only a 128px JPEG thumbnail is kept, never the original. A few KB each is
 *     what makes embedding hundreds of them in one HTML file viable at all.
 *
 * Staleness is exact rather than time-based: Zoho mints a new
 * `image_document_id` when the picture is replaced, so a cached row whose
 * `doc_id` differs from the item's current one is stale by definition and
 * nothing else needs re-fetching. See migration 004.
 *
 * The queue behaves like the invoice line-item backfill: budget-aware,
 * resumable, and it reports through `sync_state` under the entity
 * `item_images`. A 404 is recorded as `missing` so the queue stops retrying an
 * item Zoho has no picture for.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/connection');
const config = require('../config');
const logger = require('../logger');

const SYNC_ENTITY = 'item_images';
const DEFAULT_CATEGORIES = ['Badminton Jersey', 'Cycling Jersey', 'Shoes', 'String', 'Grip'];
const DEFAULT_BATCH = 200;
/** Thumbnails are for a phone list; 128px is generous already. */
const MAX_EDGE = 128;
const JPEG_QUALITY = 70;

let jimpModule = null;
function jimp() {
  // required lazily: nothing that merely reads the cache should pay for loading
  // an image library, and the test suite must not either
  if (!jimpModule) jimpModule = require('jimp');
  return jimpModule;
}

// ---------------------------------------------------------------------------
// configuration + paths
// ---------------------------------------------------------------------------

/** The categories worth a picture. Empty array = images switched off entirely. */
function imageCategories() {
  const raw = config.getSetting('stock_image_categories', DEFAULT_CATEGORIES);
  if (Array.isArray(raw)) return raw.map((c) => String(c).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((c) => String(c).trim()).filter(Boolean);
    } catch (_err) {
      return raw.split(',').map((c) => c.trim()).filter(Boolean);
    }
  }
  return [...DEFAULT_CATEGORIES];
}

function cacheDir() {
  const dir = path.join(config.DATA_DIR, 'item-images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Cache filename for an item+doc pair — doc id in the name makes staleness visible. */
function cacheFileName(itemId, docId) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '');
  return `${safe(itemId)}-${safe(docId).slice(-16)}.jpg`;
}

function cachePath(file) {
  return path.join(cacheDir(), file);
}

// ---------------------------------------------------------------------------
// the queue
// ---------------------------------------------------------------------------

/** SQL for "an in-scope item that has a picture", parameterised by category. */
function scopeSql(categories) {
  if (!categories.length) return { sql: null, params: {} };
  const params = {};
  const placeholders = categories.map((c, i) => {
    params[`c${i}`] = c;
    return `@c${i}`;
  });
  return {
    sql: `SELECT i.zoho_item_id AS item_id,
                 json_extract(i.raw_json, '$.image_document_id') AS doc_id,
                 json_extract(i.raw_json, '$.cf_item_category') AS category
            FROM items i
           WHERE i.status = 'active'
             AND i.raw_json IS NOT NULL
             AND json_extract(i.raw_json, '$.image_document_id') IS NOT NULL
             AND json_extract(i.raw_json, '$.image_document_id') <> ''
             AND json_extract(i.raw_json, '$.cf_item_category') IN (${placeholders.join(', ')})`,
    params,
  };
}

/**
 * Items whose thumbnail is absent, stale, or last failed transiently.
 *
 * `missing` rows are excluded while their doc id is unchanged — Zoho already
 * told us there is no picture there — but `error` rows ARE re-queued, or a
 * one-off network blip would cost that item its picture permanently.
 */
function pendingImages({ db = getDb(), limit = null } = {}) {
  const categories = imageCategories();
  const { sql, params } = scopeSql(categories);
  if (!sql) return [];

  return db
    .prepare(
      `SELECT s.item_id, s.doc_id, s.category
         FROM (${sql}) s
         LEFT JOIN item_images c ON c.item_id = s.item_id
        WHERE c.item_id IS NULL OR c.doc_id <> s.doc_id OR c.status = 'error'
        ORDER BY s.item_id
        ${limit ? 'LIMIT @limit' : ''}`
    )
    .all({ ...params, ...(limit ? { limit } : {}) });
}

/** Cache health, for the sync status UI and the queue itself. */
function imageProgress({ db = getDb() } = {}) {
  const categories = imageCategories();
  const { sql, params } = scopeSql(categories);
  if (!sql) return { categories, inScope: 0, cached: 0, missing: 0, pending: 0, bytes: 0 };

  const row = db
    .prepare(
      `SELECT COUNT(*) AS in_scope,
              SUM(CASE WHEN c.item_id IS NOT NULL AND c.doc_id = s.doc_id AND c.status = 'ok' THEN 1 ELSE 0 END) AS cached,
              SUM(CASE WHEN c.item_id IS NOT NULL AND c.doc_id = s.doc_id AND c.status = 'missing' THEN 1 ELSE 0 END) AS missing,
              SUM(CASE WHEN c.item_id IS NULL OR c.doc_id <> s.doc_id OR c.status = 'error' THEN 1 ELSE 0 END) AS pending
         FROM (${sql}) s
         LEFT JOIN item_images c ON c.item_id = s.item_id`
    )
    .get(params);

  const bytes = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS b FROM item_images WHERE status = 'ok'").get().b;

  return {
    categories,
    inScope: Number(row.in_scope || 0),
    cached: Number(row.cached || 0),
    missing: Number(row.missing || 0),
    pending: Number(row.pending || 0),
    bytes: Number(bytes || 0),
  };
}

/** Bytes in → 128px JPEG out. Throws on anything jimp cannot decode. */
async function makeThumbnail(buffer) {
  const { Jimp } = jimp();
  const img = await Jimp.read(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  // Only shrink. jimp's scaleToFit happily ENLARGES a small picture to fill the
  // box, which costs bytes and looks worse than the original — a 40px image
  // stays 40px.
  if (img.width > MAX_EDGE || img.height > MAX_EDGE) img.scaleToFit({ w: MAX_EDGE, h: MAX_EDGE });
  const out = await img.getBuffer('image/jpeg', { quality: JPEG_QUALITY });
  return { buffer: out, width: img.width, height: img.height };
}

function recordImage({ db = getDb(), itemId, docId, file, bytes, width, height, status, error = null }) {
  db.prepare(
    `INSERT INTO item_images (item_id, doc_id, file, bytes, width, height, status, error, fetched_at)
     VALUES (@item_id, @doc_id, @file, @bytes, @width, @height, @status, @error, datetime('now'))
     ON CONFLICT(item_id) DO UPDATE SET
       doc_id = excluded.doc_id, file = excluded.file, bytes = excluded.bytes,
       width = excluded.width, height = excluded.height, status = excluded.status,
       error = excluded.error, fetched_at = excluded.fetched_at`
  ).run({
    item_id: itemId,
    doc_id: docId,
    file: file || null,
    bytes: Number(bytes || 0),
    width: width || null,
    height: height || null,
    status,
    error,
  });
}

/** Delete a superseded thumbnail file; never let a missing file be fatal. */
function removeFile(file) {
  if (!file) return;
  try {
    fs.unlinkSync(cachePath(file));
  } catch (_err) {
    /* already gone, or never written */
  }
}

/**
 * Drain the image queue.
 *
 * @param {object}   opts
 * @param {object}   [opts.client]   a ZohoClient (injected by tests)
 * @param {number}   [opts.limit]    max items this pass
 * @param {function} [opts.now]
 */
async function syncItemImages({ client, limit = DEFAULT_BATCH, db = getDb() } = {}) {
  const { createClient } = require('../zoho/sync');
  const { BudgetExceededError, ZohoApiError } = require('../zoho/client');
  const sync = require('../zoho/sync');

  const api = client || createClient();
  const before = imageProgress({ db });

  if (!before.categories.length) {
    sync.updateSyncState(SYNC_ENTITY, {
      last_status: 'ok',
      last_error: null,
      last_run_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      total_pending: 0,
      records_synced: 0,
    });
    return { processed: 0, failed: 0, missing: 0, halted: false, skipped: 'no categories in scope', ...before };
  }

  const budget = api.budgetStatus ? api.budgetStatus() : { remaining: limit };
  const take = Math.max(0, Math.min(limit, budget.remaining));

  sync.updateSyncState(SYNC_ENTITY, {
    last_status: 'running',
    last_error: null,
    last_run_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    total_pending: before.pending,
  });

  if (take === 0) {
    const halted = before.pending > 0;
    sync.updateSyncState(SYNC_ENTITY, {
      last_status: halted ? 'halted' : 'ok',
      last_error: halted ? 'daily API budget exhausted' : null,
      last_run_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      total_pending: before.pending,
      records_synced: 0,
    });
    return { processed: 0, failed: 0, missing: 0, halted, ...before };
  }

  const queue = pendingImages({ db, limit: take });
  const existing = new Map(
    db.prepare('SELECT item_id, file FROM item_images').all().map((r) => [r.item_id, r.file])
  );

  let processed = 0;
  let failed = 0;
  let missing = 0;
  let halted = false;
  let lastError = null;

  for (const row of queue) {
    try {
      const { buffer } = await api.getBinary(`/items/${row.item_id}/image`);
      if (!buffer || !buffer.length) throw new Error('empty image response');

      const thumb = await makeThumbnail(buffer);
      const file = cacheFileName(row.item_id, row.doc_id);
      fs.writeFileSync(cachePath(file), thumb.buffer);

      const previous = existing.get(row.item_id);
      if (previous && previous !== file) removeFile(previous);

      recordImage({
        db,
        itemId: row.item_id,
        docId: row.doc_id,
        file,
        bytes: thumb.buffer.length,
        width: thumb.width,
        height: thumb.height,
        status: 'ok',
      });
      processed += 1;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        halted = true;
        lastError = err.message;
        break;
      }
      // Zoho has no picture here. Permanent until the item's doc id changes,
      // so record it and stop asking — otherwise the queue never drains.
      if (err instanceof ZohoApiError && err.status === 404) {
        recordImage({ db, itemId: row.item_id, docId: row.doc_id, status: 'missing', error: err.message });
        missing += 1;
        continue;
      }
      failed += 1;
      lastError = err.message;
      recordImage({ db, itemId: row.item_id, docId: row.doc_id, status: 'error', error: err.message });
      logger.warn({ err: err.message, item: row.item_id }, 'item image fetch failed');
    }
  }

  const after = imageProgress({ db });
  // the budget can also run out by simply capping this pass: if work remains
  // and there is nothing left to spend, say halted rather than ok
  if (!halted && after.pending > 0 && api.budgetStatus && api.budgetStatus().remaining <= 0) {
    halted = true;
    lastError = lastError || 'daily API budget exhausted';
  }

  sync.updateSyncState(SYNC_ENTITY, {
    last_status: halted ? 'halted' : failed ? 'error' : 'ok',
    last_error: lastError,
    last_run_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    total_pending: after.pending,
    records_synced: processed,
  });

  logger.info({ processed, failed, missing, halted, pending: after.pending }, 'item image queue drained');
  return { processed, failed, missing, halted, ...after };
}

// ---------------------------------------------------------------------------
// reading the cache (the stock file)
// ---------------------------------------------------------------------------

/**
 * item id → `data:image/jpeg;base64,...` for every usable cached thumbnail in
 * the requested categories. One read of the whole cache is far cheaper than a
 * file read per colour row, and the caller embeds only what it uses.
 */
function loadThumbnails({ db = getDb(), itemIds = null } = {}) {
  const out = new Map();
  const rows = db.prepare("SELECT item_id, file FROM item_images WHERE status = 'ok' AND file IS NOT NULL").all();
  const wanted = itemIds ? new Set(itemIds.map(String)) : null;

  for (const row of rows) {
    if (wanted && !wanted.has(String(row.item_id))) continue;
    try {
      const bytes = fs.readFileSync(cachePath(row.file));
      out.set(String(row.item_id), `data:image/jpeg;base64,${bytes.toString('base64')}`);
    } catch (_err) {
      // the index says there is a file and there is not: treat as no image
      // rather than failing a whole report over one thumbnail
    }
  }
  return out;
}

/** Drop cache rows and files for items that no longer exist or left scope. */
function pruneCache({ db = getDb() } = {}) {
  const categories = imageCategories();
  const { sql, params } = scopeSql(categories);
  const stale = sql
    ? db
        .prepare(
          `SELECT c.item_id, c.file FROM item_images c
            WHERE c.item_id NOT IN (SELECT item_id FROM (${sql}))`
        )
        .all(params)
    : db.prepare('SELECT item_id, file FROM item_images').all();

  const remove = db.prepare('DELETE FROM item_images WHERE item_id = ?');
  for (const row of stale) {
    removeFile(row.file);
    remove.run(row.item_id);
  }
  return { pruned: stale.length };
}

module.exports = {
  SYNC_ENTITY,
  DEFAULT_CATEGORIES,
  DEFAULT_BATCH,
  MAX_EDGE,
  JPEG_QUALITY,
  imageCategories,
  cacheDir,
  cacheFileName,
  cachePath,
  pendingImages,
  imageProgress,
  makeThumbnail,
  syncItemImages,
  loadThumbnails,
  pruneCache,
};
