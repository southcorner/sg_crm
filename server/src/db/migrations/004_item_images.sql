-- =============================================================================
-- Item image thumbnails, and the per-profile switch that embeds them.
--
-- Zoho serves an item's picture from GET /items/{id}/image — one API call each,
-- against the same daily budget as everything else. Fetching 1,000+ of those on
-- every report would be absurd, so images are cached: this table is the queue's
-- memory and the cache index in one.
--
--   doc_id   the item's `image_document_id` AT THE TIME WE FETCHED. Zoho mints a
--            new one whenever the picture is replaced, so `doc_id <> the item's
--            current image_document_id` is exactly "this thumbnail is stale".
--   file     basename inside data\item-images\ (the JPEG thumbnail — the
--            original is never kept; a few KB each is the whole point).
--   status   ok      usable thumbnail on disk
--            missing Zoho has no image for this item (404). Permanent until the
--                    item's doc id changes, so the queue stops retrying it —
--                    the same trick invoices use with line_items_synced = 2.
--            error   transient failure; the queue will try again.
--
-- Rows are keyed by item and cascade with it, so deleting an item cleans up its
-- index entry (the file on disk is swept by the service).
-- =============================================================================

CREATE TABLE item_images (
  item_id    TEXT PRIMARY KEY REFERENCES items(zoho_item_id) ON DELETE CASCADE,
  doc_id     TEXT NOT NULL,
  file       TEXT,
  bytes      INTEGER NOT NULL DEFAULT 0,
  width      INTEGER,
  height     INTEGER,
  status     TEXT NOT NULL DEFAULT 'ok',
  error      TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_item_images_status ON item_images(status, fetched_at);

-- Per-profile: embed the thumbnails in that profile's file, or keep it lean.
-- Default on — the admin asked for pictures; a profile can opt out (and the
-- 5 MB size guardrail drops them automatically when a file gets too big).
ALTER TABLE stock_report_profiles ADD COLUMN include_images INTEGER NOT NULL DEFAULT 1;
