-- =============================================================================
-- Cached thumbnails learn which rendition they are.
--
-- The cache was built at 128px, for a list row. Tapping a thumbnail now opens a
-- lightbox, so the same file has to look right at ~44px AND full-screen, which
-- means a bigger rendition. One file still serves both uses — storing the
-- original would blow the 5 MB attachment budget.
--
-- `variant` records the rendition a row was fetched at ("320q72"). The queue
-- compares it against the CURRENT configured rendition and re-fetches anything
-- that differs, so this is not a one-off migration for one size change: adjust
-- `stock_image_max_edge` (or the quality constant) in a later release and the
-- cache invalidates itself, exactly the same way.
--
-- Existing rows get NULL, which never equals the current variant — so every
-- 128px thumbnail already on disk is stale from this moment and the queue picks
-- them up on its next pass, within the daily API budget as usual.
-- =============================================================================

ALTER TABLE item_images ADD COLUMN variant TEXT;

CREATE INDEX idx_item_images_variant ON item_images(variant);
