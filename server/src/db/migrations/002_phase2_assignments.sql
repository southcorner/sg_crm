-- =============================================================================
-- Phase 2 — rep-attribution bookkeeping.
--
-- customer_rep_assignments rows are never deleted by a reassignment, so the
-- history stays intact and every reassignment is reversible:
--
--   * "from today"  closes the current open row (effective_to = today) and
--     stamps `closed_by` with the new row's id.
--   * "all history" inserts a row at effective_from = '0000-01-01' and marks
--     every previously-active row `superseded_at` / `superseded_by`.
--
-- Deleting an assignment restores whatever it closed or superseded, so the
-- effective-rep resolution goes back to exactly what it was before.
-- Only rows with superseded_at IS NULL take part in attribution.
-- =============================================================================

ALTER TABLE customer_rep_assignments ADD COLUMN mode TEXT;
ALTER TABLE customer_rep_assignments ADD COLUMN superseded_at TEXT;
ALTER TABLE customer_rep_assignments ADD COLUMN superseded_by INTEGER;
ALTER TABLE customer_rep_assignments ADD COLUMN closed_by INTEGER;

CREATE INDEX idx_assign_active
  ON customer_rep_assignments(customer_id, superseded_at, effective_from);

-- brand rollups walk line items by item; keep the item lookup cheap.
CREATE INDEX IF NOT EXISTS idx_line_items_invoice_item
  ON invoice_line_items(invoice_id, item_id);
