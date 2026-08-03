-- =============================================================================
-- Per-recipient stock-report profiles.
--
-- The stock report started as one global config: one recipient list, one set of
-- exclusions, one threshold. That only ever suited one audience. A profile is
-- that same config, named, so the same nightly job can send a Racket-only file
-- to one dealer group and an everything-but-Unbranded file to another.
--
-- The daily job iterates enabled profiles that have recipients; each gets its
-- own tailored body + HTML attachment and its own once-per-day guard row in
-- reminders_log (entity_id = '<profile id>:<date>').
--
-- MIGRATION OF THE EXISTING SETUP: if the pre-profile settings already carry
-- recipients, they become a profile named "Default" with exactly the same
-- exclusions and threshold, so a configured server keeps behaving identically
-- across this upgrade. A server that never configured the report gets no
-- profile at all (and therefore still sends nothing). After this migration the
-- legacy stock_report_recipients / _excluded_brands / _excluded_categories /
-- _threshold settings drive nothing — they are left in place only as a record
-- of what was migrated.
-- =============================================================================

CREATE TABLE stock_report_profiles (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  name                     TEXT NOT NULL,
  -- JSON arrays: ["a@x.in", ...] / [23, 0, ...] (brand ids, 0 = Unbranded) /
  -- ["Racket", ...] (display category names)
  recipients_json          TEXT NOT NULL DEFAULT '[]',
  excluded_brands_json     TEXT NOT NULL DEFAULT '[]',
  excluded_categories_json TEXT NOT NULL DEFAULT '[]',
  threshold                INTEGER NOT NULL DEFAULT 25,
  enabled                  INTEGER NOT NULL DEFAULT 1,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  note                     TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_stock_profiles_enabled ON stock_report_profiles(enabled, sort_order, id);

-- Seed "Default" from the pre-profile settings, but only when the report was
-- actually configured (recipients present). Settings values are JSON-encoded,
-- hence the json_extract for the scalar threshold; anything unparsable falls
-- back to the shipped defaults rather than failing the migration.
INSERT INTO stock_report_profiles
  (name, recipients_json, excluded_brands_json, excluded_categories_json, threshold, enabled, sort_order, note)
SELECT
  'Default',
  s.recipients,
  CASE WHEN json_valid(s.brands) AND json_type(s.brands) = 'array' THEN s.brands ELSE '[]' END,
  CASE WHEN json_valid(s.cats) AND json_type(s.cats) = 'array' THEN s.cats ELSE '[]' END,
  CASE
    WHEN json_valid(s.threshold) AND CAST(json_extract(s.threshold, '$') AS INTEGER) >= 1
      THEN CAST(json_extract(s.threshold, '$') AS INTEGER)
    ELSE 25
  END,
  1,
  0,
  'Migrated from the single global stock-report configuration.'
FROM (
  SELECT
    COALESCE((SELECT value FROM settings WHERE key = 'stock_report_recipients'), '[]')         AS recipients,
    COALESCE((SELECT value FROM settings WHERE key = 'stock_report_excluded_brands'), '[]')    AS brands,
    COALESCE((SELECT value FROM settings WHERE key = 'stock_report_excluded_categories'), '[]') AS cats,
    COALESCE((SELECT value FROM settings WHERE key = 'stock_report_threshold'), '25')          AS threshold
) s
WHERE json_valid(s.recipients)
  AND json_type(s.recipients) = 'array'
  AND json_array_length(s.recipients) > 0;
