-- =============================================================================
-- SG CRM — initial schema
--
-- Conventions:
--   * Zoho IDs are TEXT (they overflow JS numbers).
--   * Every synced table keeps `raw_json` + `last_modified_time` so we can
--     re-derive fields later without re-hitting the API.
--   * Dates are stored as TEXT: 'YYYY-MM-DD' for business dates, ISO-8601 for
--     timestamps (Zoho's last_modified_time keeps its +0530 offset verbatim).
--   * Money is REAL (INR, 2dp) — good enough for reporting on this data volume.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SYNCED FROM ZOHO BOOKS
-- -----------------------------------------------------------------------------

CREATE TABLE customers (
  zoho_contact_id        TEXT PRIMARY KEY,
  contact_name           TEXT NOT NULL DEFAULT '',
  company_name           TEXT,
  email                  TEXT,
  phone                  TEXT,
  mobile                 TEXT,
  contact_type           TEXT,               -- 'customer'
  status                 TEXT,               -- active | inactive
  gst_no                 TEXT,
  place_of_contact       TEXT,
  currency_code          TEXT,
  payment_terms          INTEGER,
  payment_terms_label    TEXT,
  outstanding_receivable REAL NOT NULL DEFAULT 0,
  unused_credits         REAL NOT NULL DEFAULT 0,
  billing_address_json   TEXT,
  shipping_address_json  TEXT,
  zoho_salesperson_id    TEXT,               -- Zoho's own default salesperson, if any
  -- denormalized, recomputed after each sync (see services/dormant.js)
  first_invoice_date     TEXT,
  last_invoice_date      TEXT,
  invoice_count          INTEGER NOT NULL DEFAULT 0,
  raw_json               TEXT,
  last_modified_time     TEXT,
  synced_at              TEXT NOT NULL DEFAULT (datetime('now')),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_customers_name              ON customers(contact_name);
CREATE INDEX idx_customers_last_invoice_date ON customers(last_invoice_date);
CREATE INDEX idx_customers_outstanding       ON customers(outstanding_receivable);
CREATE INDEX idx_customers_last_modified     ON customers(last_modified_time);

-- Salespersons: Zoho columns are overwritten by sync; the crm_* / notify_*
-- columns are CRM-owned and MUST never be touched by the sync upsert.
CREATE TABLE salespersons (
  zoho_salesperson_id TEXT PRIMARY KEY,
  name                TEXT NOT NULL DEFAULT '',
  email               TEXT,                 -- from Zoho
  is_active           INTEGER NOT NULL DEFAULT 1,
  -- CRM-managed contact / notification config
  crm_email           TEXT,
  whatsapp_number     TEXT,                 -- digits, e.g. 919876543210
  notify_email        INTEGER NOT NULL DEFAULT 1,
  notify_whatsapp     INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  raw_json            TEXT,
  last_modified_time  TEXT,
  synced_at           TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_salespersons_name ON salespersons(name);

CREATE TABLE invoices (
  zoho_invoice_id     TEXT PRIMARY KEY,
  invoice_number      TEXT,
  customer_id         TEXT REFERENCES customers(zoho_contact_id) ON DELETE SET NULL,
  customer_name       TEXT,
  salesperson_id      TEXT,                 -- may be NULL / unknown on old invoices
  salesperson_name    TEXT,
  invoice_date        TEXT,                 -- YYYY-MM-DD
  due_date            TEXT,                 -- YYYY-MM-DD
  status              TEXT,                 -- draft|sent|overdue|paid|partially_paid|void
  total               REAL NOT NULL DEFAULT 0,
  sub_total           REAL NOT NULL DEFAULT 0,
  balance             REAL NOT NULL DEFAULT 0,
  currency_code       TEXT,
  reference_number    TEXT,
  -- 0 until the invoice-detail second pass has pulled its line items
  line_items_synced   INTEGER NOT NULL DEFAULT 0,
  line_items_synced_at TEXT,
  raw_json            TEXT,
  last_modified_time  TEXT,
  synced_at           TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_invoices_customer      ON invoices(customer_id);
CREATE INDEX idx_invoices_salesperson   ON invoices(salesperson_id);
CREATE INDEX idx_invoices_date          ON invoices(invoice_date);
CREATE INDEX idx_invoices_due_date      ON invoices(due_date);
CREATE INDEX idx_invoices_status        ON invoices(status);
CREATE INDEX idx_invoices_balance       ON invoices(balance);
CREATE INDEX idx_invoices_pending_lines ON invoices(line_items_synced, invoice_date);
CREATE INDEX idx_invoices_last_modified ON invoices(last_modified_time);

CREATE TABLE invoice_line_items (
  zoho_line_item_id TEXT PRIMARY KEY,
  invoice_id        TEXT NOT NULL REFERENCES invoices(zoho_invoice_id) ON DELETE CASCADE,
  item_id           TEXT,                   -- may be NULL for ad-hoc lines
  line_order        INTEGER NOT NULL DEFAULT 0,
  name              TEXT,
  description       TEXT,
  sku               TEXT,
  quantity          REAL NOT NULL DEFAULT 0,
  unit              TEXT,
  rate              REAL NOT NULL DEFAULT 0,
  discount_amount   REAL NOT NULL DEFAULT 0,
  item_total        REAL NOT NULL DEFAULT 0,
  raw_json          TEXT,
  synced_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_line_items_invoice ON invoice_line_items(invoice_id);
CREATE INDEX idx_line_items_item    ON invoice_line_items(item_id);

CREATE TABLE payments (
  zoho_payment_id    TEXT PRIMARY KEY,
  payment_number     TEXT,
  customer_id        TEXT REFERENCES customers(zoho_contact_id) ON DELETE SET NULL,
  customer_name      TEXT,
  payment_date       TEXT,                  -- YYYY-MM-DD
  amount             REAL NOT NULL DEFAULT 0,
  unused_amount      REAL NOT NULL DEFAULT 0,
  bank_charges       REAL NOT NULL DEFAULT 0,
  payment_mode       TEXT,                  -- cash|cheque|banktransfer|...
  reference_number   TEXT,
  description        TEXT,
  -- [{invoice_id, invoice_number, amount_applied, date}, ...]
  applied_invoices_json TEXT,
  raw_json           TEXT,
  last_modified_time TEXT,
  synced_at          TEXT NOT NULL DEFAULT (datetime('now')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_payments_customer      ON payments(customer_id);
CREATE INDEX idx_payments_date          ON payments(payment_date);
CREATE INDEX idx_payments_mode          ON payments(payment_mode);
CREATE INDEX idx_payments_last_modified ON payments(last_modified_time);

CREATE TABLE items (
  zoho_item_id       TEXT PRIMARY KEY,
  name               TEXT NOT NULL DEFAULT '',
  sku                TEXT,
  description        TEXT,
  category_id        TEXT,
  category_name      TEXT,
  unit               TEXT,
  rate               REAL NOT NULL DEFAULT 0,
  status             TEXT,
  product_type       TEXT,
  -- custom fields are needed by brand rules; may be filled lazily via /items/{id}
  custom_fields_json TEXT,
  custom_fields_synced INTEGER NOT NULL DEFAULT 0,
  raw_json           TEXT,
  last_modified_time TEXT,
  synced_at          TEXT NOT NULL DEFAULT (datetime('now')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_items_name          ON items(name);
CREATE INDEX idx_items_sku           ON items(sku);
CREATE INDEX idx_items_category      ON items(category_name);
CREATE INDEX idx_items_last_modified ON items(last_modified_time);

-- -----------------------------------------------------------------------------
-- CRM-OWNED
-- -----------------------------------------------------------------------------

CREATE TABLE brands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ordered rules evaluated lowest priority number first; first match wins.
CREATE TABLE brand_rules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id          INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  rule_type         TEXT NOT NULL CHECK (rule_type IN ('custom_field', 'category', 'name_pattern', 'sku_pattern')),
  custom_field_name TEXT,                   -- only for rule_type='custom_field'
  match_value       TEXT NOT NULL,          -- exact value, or a LIKE/glob pattern
  priority          INTEGER NOT NULL DEFAULT 100,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_brand_rules_priority ON brand_rules(priority, id);
CREATE INDEX idx_brand_rules_brand    ON brand_rules(brand_id);

-- Materialized item -> brand mapping. source='manual' rows are NEVER
-- auto-overwritten by a rules re-run.
CREATE TABLE item_brand_map (
  item_id    TEXT PRIMARY KEY REFERENCES items(zoho_item_id) ON DELETE CASCADE,
  brand_id   INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT 'rule' CHECK (source IN ('rule', 'manual')),
  rule_id    INTEGER REFERENCES brand_rules(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_item_brand_map_brand  ON item_brand_map(brand_id);
CREATE INDEX idx_item_brand_map_source ON item_brand_map(source);

-- Effective-rep resolution. An invoice dated within [effective_from, effective_to]
-- is attributed to `salesperson_id`; otherwise the invoice's own salesperson wins.
-- "Re-attribute all history" uses effective_from = '0000-01-01'.
CREATE TABLE customer_rep_assignments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    TEXT NOT NULL REFERENCES customers(zoho_contact_id) ON DELETE CASCADE,
  salesperson_id TEXT NOT NULL REFERENCES salespersons(zoho_salesperson_id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL,             -- YYYY-MM-DD ('0000-01-01' = all history)
  effective_to   TEXT,                      -- NULL = open ended
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_assign_customer    ON customer_rep_assignments(customer_id, effective_from);
CREATE INDEX idx_assign_salesperson ON customer_rep_assignments(salesperson_id);

-- Monthly targets per rep, optionally per brand (brand_id NULL = all brands).
CREATE TABLE targets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  salesperson_id TEXT NOT NULL REFERENCES salespersons(zoho_salesperson_id) ON DELETE CASCADE,
  month          TEXT NOT NULL,             -- 'YYYY-MM'
  brand_id       INTEGER REFERENCES brands(id) ON DELETE CASCADE,
  target_amount  REAL NOT NULL DEFAULT 0,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- NULL brand_id must collide with itself, hence IFNULL(...) in the unique index.
CREATE UNIQUE INDEX idx_targets_unique ON targets(salesperson_id, month, IFNULL(brand_id, 0));
CREATE INDEX idx_targets_month ON targets(month);

CREATE TABLE focus_plans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  month          TEXT NOT NULL,             -- 'YYYY-MM'
  customer_id    TEXT NOT NULL REFERENCES customers(zoho_contact_id) ON DELETE CASCADE,
  salesperson_id TEXT REFERENCES salespersons(zoho_salesperson_id) ON DELETE SET NULL,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_focus_unique      ON focus_plans(month, customer_id);
CREATE INDEX        idx_focus_month       ON focus_plans(month, status);
CREATE INDEX        idx_focus_salesperson ON focus_plans(salesperson_id);

CREATE TABLE cheques (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     TEXT NOT NULL REFERENCES customers(zoho_contact_id) ON DELETE CASCADE,
  salesperson_id  TEXT REFERENCES salespersons(zoho_salesperson_id) ON DELETE SET NULL,
  amount          REAL NOT NULL DEFAULT 0,
  cheque_number   TEXT,
  bank_name       TEXT,
  cheque_date     TEXT,                     -- date written on the cheque
  deposit_date    TEXT,                     -- YYYY-MM-DD — drives the reminder
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'deposited', 'cleared', 'bounced')),
  zoho_payment_id TEXT REFERENCES payments(zoho_payment_id) ON DELETE SET NULL,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cheques_deposit_date ON cheques(deposit_date, status);
CREATE INDEX idx_cheques_customer     ON cheques(customer_id);
CREATE INDEX idx_cheques_status       ON cheques(status);

-- Every reminder attempt. Also the dedupe source: a per-rep/day 'digest' row
-- prevents a double send after a crash-restart.
CREATE TABLE reminders_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date       TEXT NOT NULL,             -- YYYY-MM-DD (local)
  rule_type      TEXT NOT NULL,             -- digest|overdue|cheque|dormant|focus
  entity_type    TEXT,                      -- invoice|cheque|customer|...
  entity_id      TEXT,
  salesperson_id TEXT REFERENCES salespersons(zoho_salesperson_id) ON DELETE SET NULL,
  channel        TEXT,                      -- email|whatsapp|none
  status         TEXT NOT NULL DEFAULT 'sent',  -- sent|failed|skipped
  detail         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_reminders_run_date ON reminders_log(run_date, rule_type);
CREATE INDEX idx_reminders_rep      ON reminders_log(salesperson_id, run_date);
CREATE INDEX idx_reminders_entity   ON reminders_log(rule_type, entity_type, entity_id, created_at);

-- UI-editable config. `value` is JSON-encoded.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per synced entity: incremental cursor + last run outcome.
CREATE TABLE sync_state (
  entity          TEXT PRIMARY KEY,         -- customers|invoices|payments|items|salespersons|invoice_details
  cursor          TEXT,                     -- ISO last_modified_time with +0530 offset
  last_run_at     TEXT,
  last_status     TEXT,                     -- ok|error|running|halted
  last_error      TEXT,
  records_synced  INTEGER NOT NULL DEFAULT 0,
  total_pending   INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single admin login.
CREATE TABLE admin_user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
