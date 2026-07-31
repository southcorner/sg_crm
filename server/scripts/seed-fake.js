'use strict';

/**
 * DEV ONLY — fake data seeder.
 *
 * Fills the local database with plausible-looking customers, salespersons,
 * items, invoices (with line items) and payments so the UI can be developed and
 * verified without a live Zoho connection.
 *
 *   node server/scripts/seed-fake.js            # add fake rows
 *   node server/scripts/seed-fake.js --reset    # wipe synced tables first
 *
 * NOTHING calls this automatically — it is never wired into the server boot,
 * migrations or cron. It refuses to run when NODE_ENV=production unless
 * ALLOW_FAKE_SEED=1 is set. All rows it writes carry a FAKE- id prefix so they
 * are easy to spot (and delete) next to real Zoho data.
 */

const path = require('path');
const config = require('../src/config');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');

const PREFIX = 'FAKE-';

if (config.isProduction && process.env.ALLOW_FAKE_SEED !== '1') {
  console.error('refusing to seed fake data with NODE_ENV=production (set ALLOW_FAKE_SEED=1 to force)');
  process.exit(1);
}

// deterministic PRNG so re-seeding gives the same shape of data
let seed = 20260731;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const intBetween = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const money = (a, b) => Math.round((a + rnd() * (b - a)) * 100) / 100;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
/** Local (not UTC) YYYY-MM-DD — matches services/attribution.todayIso(). */
function localIso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function zohoTime(d) {
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())}T${p(
    ist.getUTCHours()
  )}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}+0530`;
}

const REPS = [
  { id: `${PREFIX}SP1`, name: 'Anil Mehta', email: 'anil@example.in' },
  { id: `${PREFIX}SP2`, name: 'Priya Nair', email: 'priya@example.in' },
  { id: `${PREFIX}SP3`, name: 'Rahul Desai', email: 'rahul@example.in' },
];

const CUSTOMER_NAMES = [
  ['Sharma Cycle Mart', 'Sharma Cycle Mart Pvt Ltd', 'Pune'],
  ['Velocity Bikes', 'Velocity Bikes LLP', 'Mumbai'],
  ['Gearhead Sports', 'Gearhead Sports Pvt Ltd', 'Bengaluru'],
  ['Trailblazer Cycles', 'Trailblazer Cycles', 'Hyderabad'],
  ['Metro Wheels', 'Metro Wheels Trading Co', 'Delhi'],
  ['Peak Performance Store', 'Peak Performance Retail', 'Chandigarh'],
  ['Coastal Cyclery', 'Coastal Cyclery Pvt Ltd', 'Kochi'],
  ['Urban Ride Hub', 'Urban Ride Hub', 'Ahmedabad'],
  ['Summit Sports House', 'Summit Sports House Pvt Ltd', 'Jaipur'],
  ['Rapid Gear Traders', 'Rapid Gear Traders', 'Nagpur'],
];

const ITEMS = [
  ['Alloy MTB Frame 18"', 'FRM-MTB-18', 'Frames', 8500],
  ['Carbon Road Fork', 'FRK-RD-CB', 'Frames', 12500],
  ['Hydraulic Disc Brake Set', 'BRK-HYD-SET', 'Components', 4200],
  ['11-Speed Cassette', 'CST-11S', 'Components', 2800],
  ['Tubeless Tyre 29x2.2', 'TYR-29-22', 'Tyres', 1950],
  ['Helmet Pro Vent', 'HLM-PRO', 'Accessories', 2400],
  ['LED Head Light 800L', 'LGT-800', 'Accessories', 1600],
  ['Bike Service Kit', 'SVC-KIT', 'Accessories', 990],
];

const PAYMENT_MODES = ['cash', 'banktransfer', 'cheque', 'upi'];

function reset(db) {
  const tables = [
    'cheques',
    'focus_plans',
    'item_brand_map',
    'brand_rules',
    'brands',
    'customer_rep_assignments',
    'targets',
    'invoice_line_items',
    'payments',
    'invoices',
    'items',
    'customers',
    'salespersons',
    'sync_state',
  ];
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  db.exec('PRAGMA foreign_keys = ON');
  console.log(`reset: cleared ${tables.join(', ')}`);
}

function seedAll({ doReset = false } = {}) {
  runMigrations();
  config.seedSettingDefaults();
  const db = getDb();
  if (doReset) reset(db);

  const sync = require('../src/zoho/sync');

  // --- salespersons -------------------------------------------------------
  sync.upsertSalespersons(
    REPS.map((r) => ({
      salesperson_id: r.id,
      salesperson_name: r.name,
      salesperson_email: r.email,
      status: 'active',
      last_modified_time: zohoTime(daysAgo(120)),
    }))
  );

  // --- items --------------------------------------------------------------
  const items = ITEMS.map(([name, sku, category, rate], idx) => ({
    item_id: `${PREFIX}ITM${idx + 1}`,
    name,
    sku,
    category_name: category,
    unit: 'nos',
    rate,
    status: 'active',
    product_type: 'goods',
    custom_fields: [{ label: 'Brand', value: category === 'Frames' ? 'Battalion' : 'Sundry' }],
    last_modified_time: zohoTime(daysAgo(90)),
  }));
  sync.upsertItems(items);

  // --- customers ----------------------------------------------------------
  const customers = CUSTOMER_NAMES.map(([name, company, city], idx) => ({
    contact_id: `${PREFIX}CUST${idx + 1}`,
    contact_name: name,
    company_name: company,
    email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.in`,
    phone: `020-${intBetween(2000000, 4999999)}`,
    mobile: `9${intBetween(100000000, 999999999)}`,
    contact_type: 'customer',
    status: idx === 9 ? 'inactive' : 'active',
    gst_no: `27AAAAA${intBetween(1000, 9999)}A1Z${intBetween(1, 9)}`,
    place_of_contact: city,
    currency_code: 'INR',
    payment_terms: pick([15, 30, 45]),
    payment_terms_label: 'Net 30',
    outstanding_receivable: 0,
    unused_credits_receivable_amount: 0,
    billing_address: {
      address: `${intBetween(1, 200)} MG Road`,
      city,
      state: 'Maharashtra',
      zip: String(intBetween(400001, 499999)),
      country: 'India',
    },
    shipping_address: { address: `Warehouse ${idx + 1}`, city, country: 'India' },
    last_modified_time: zohoTime(daysAgo(intBetween(1, 60))),
  }));
  sync.upsertCustomers(customers);

  // --- invoices + line items ---------------------------------------------
  const invoices = [];
  const lineItemsByInvoice = new Map();

  for (let i = 0; i < 30; i += 1) {
    const customer = customers[i % customers.length];
    const rep = REPS[i % REPS.length];
    const ageDays = intBetween(1, 200);
    const date = daysAgo(ageDays);
    const terms = 30;
    const due = new Date(date.getTime() + terms * 86400000);

    const lines = [];
    const lineCount = intBetween(1, 4);
    let subTotal = 0;
    for (let l = 0; l < lineCount; l += 1) {
      const item = items[(i + l) % items.length];
      const qty = intBetween(1, 6);
      const rate = item.rate;
      const itemTotal = Math.round(qty * rate * 100) / 100;
      subTotal += itemTotal;
      lines.push({
        line_item_id: `${PREFIX}LI${i + 1}-${l + 1}`,
        item_id: item.item_id,
        name: item.name,
        description: `${item.name} — ${item.category_name}`,
        sku: item.sku,
        quantity: qty,
        unit: 'nos',
        rate,
        discount_amount: 0,
        item_total: itemTotal,
      });
    }
    const total = Math.round(subTotal * 1.18 * 100) / 100; // 18% GST

    // mix of paid / partially paid / overdue / draft / void
    let status;
    let balance;
    const roll = i % 10;
    if (roll === 0) {
      status = 'draft';
      balance = total;
    } else if (roll === 1) {
      status = 'void';
      balance = 0;
    } else if (roll < 5) {
      status = 'paid';
      balance = 0;
    } else if (roll < 7) {
      status = 'partially_paid';
      balance = Math.round(total * 0.4 * 100) / 100;
    } else {
      status = due < new Date() ? 'overdue' : 'sent';
      balance = total;
    }

    const invoiceId = `${PREFIX}INV${i + 1}`;
    invoices.push({
      invoice_id: invoiceId,
      invoice_number: `INV-${String(1000 + i)}`,
      customer_id: customer.contact_id,
      customer_name: customer.contact_name,
      salesperson_id: rep.id,
      salesperson_name: rep.name,
      date: isoDate(date),
      due_date: isoDate(due),
      status,
      total,
      sub_total: Math.round(subTotal * 100) / 100,
      balance,
      currency_code: 'INR',
      reference_number: `PO-${intBetween(100, 999)}`,
      last_modified_time: zohoTime(daysAgo(Math.max(0, ageDays - 1))),
    });
    lineItemsByInvoice.set(invoiceId, lines);
  }

  // a handful of guaranteed current-month invoices so the MTD KPI is non-zero
  // (customers 3 and 4 are the ones phase 2 reassigns, so they need MTD rows)
  for (let i = 0; i < 5; i += 1) {
    const customer = customers[i];
    const rep = REPS[i % REPS.length];
    const d = new Date();
    d.setDate(Math.min(d.getDate(), 3 + i * 2));
    const due = new Date(d.getTime() + 30 * 86400000);
    const item = items[i];
    const qty = intBetween(2, 8);
    const subTotal = qty * item.rate;
    const total = Math.round(subTotal * 1.18 * 100) / 100;
    const invoiceId = `${PREFIX}INV-MTD${i + 1}`;
    invoices.push({
      invoice_id: invoiceId,
      invoice_number: `INV-${String(2000 + i)}`,
      customer_id: customer.contact_id,
      customer_name: customer.contact_name,
      salesperson_id: rep.id,
      salesperson_name: rep.name,
      date: isoDate(d),
      due_date: isoDate(due),
      status: 'sent',
      total,
      sub_total: subTotal,
      balance: total,
      currency_code: 'INR',
      reference_number: `PO-${intBetween(100, 999)}`,
      last_modified_time: zohoTime(new Date()),
    });
    lineItemsByInvoice.set(invoiceId, [
      {
        line_item_id: `${PREFIX}LI-MTD${i + 1}`,
        item_id: item.item_id,
        name: item.name,
        description: item.name,
        sku: item.sku,
        quantity: qty,
        unit: 'nos',
        rate: item.rate,
        discount_amount: 0,
        item_total: subTotal,
      },
    ]);
  }

  // Invoices dated TODAY for the two customers phase 2 reassigns, so the
  // "from today" split is visible inside a single month: their mid-month
  // invoice stays with the old rep, this one moves to the new one.
  [3, 4].forEach((idx, n) => {
    const customer = customers[idx];
    const rep = REPS[idx % REPS.length];
    const today = localIso(new Date());
    const due = new Date(Date.now() + 30 * 86400000);
    const item = items[(idx + 2) % items.length];
    const qty = intBetween(2, 6);
    const subTotal = qty * item.rate;
    const total = Math.round(subTotal * 1.18 * 100) / 100;
    const invoiceId = `${PREFIX}INV-TODAY${n + 1}`;
    invoices.push({
      invoice_id: invoiceId,
      invoice_number: `INV-${String(2100 + n)}`,
      customer_id: customer.contact_id,
      customer_name: customer.contact_name,
      salesperson_id: rep.id,
      salesperson_name: rep.name,
      date: today,
      due_date: isoDate(due),
      status: 'sent',
      total,
      sub_total: subTotal,
      balance: total,
      currency_code: 'INR',
      reference_number: `PO-${intBetween(100, 999)}`,
      last_modified_time: zohoTime(new Date()),
    });
    lineItemsByInvoice.set(invoiceId, [
      {
        line_item_id: `${PREFIX}LI-TODAY${n + 1}`,
        item_id: item.item_id,
        name: item.name,
        description: item.name,
        sku: item.sku,
        quantity: qty,
        unit: 'nos',
        rate: item.rate,
        discount_amount: 0,
        item_total: subTotal,
      },
    ]);
  });

  sync.upsertInvoices(invoices);

  // line items: same path the real second pass uses, so flags line up
  const insertLines = db.transaction(() => {
    for (const [invoiceId, lines] of lineItemsByInvoice) {
      db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?').run(invoiceId);
      lines.forEach((li, idx) => {
        db.prepare(
          `INSERT INTO invoice_line_items (
             zoho_line_item_id, invoice_id, item_id, line_order, name, description, sku,
             quantity, unit, rate, discount_amount, item_total, raw_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          li.line_item_id,
          invoiceId,
          li.item_id,
          idx,
          li.name,
          li.description,
          li.sku,
          li.quantity,
          li.unit,
          li.rate,
          li.discount_amount,
          li.item_total,
          JSON.stringify(li)
        );
      });
    }
  });
  insertLines();

  // leave 4 invoices unsynced so the backfill progress bar — and the phase-2
  // "N invoices pending line-item sync" banner — have something to show.
  // Deliberately NOT the newest ones: those carry the brand/attribution demo.
  const unsynced = invoices.slice(8, 12).map((i) => i.invoice_id);
  const markSynced = db.prepare(
    `UPDATE invoices SET line_items_synced = 1, line_items_synced_at = datetime('now') WHERE zoho_invoice_id = ?`
  );
  const markUnsynced = db.prepare(
    'UPDATE invoices SET line_items_synced = 0, line_items_synced_at = NULL WHERE zoho_invoice_id = ?'
  );
  // A pending invoice genuinely has no line-item rows yet — that is what makes
  // it invisible to the brand rollups, so the seeded state has to match.
  const dropLines = db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?');
  db.transaction(() => {
    for (const inv of invoices) markSynced.run(inv.invoice_id);
    for (const id of unsynced) {
      markUnsynced.run(id);
      dropLines.run(id);
    }
  })();

  // --- payments -----------------------------------------------------------
  const payments = [];
  let pNo = 1;
  for (const inv of invoices) {
    if (inv.status !== 'paid' && inv.status !== 'partially_paid') continue;
    const applied = Math.round((inv.total - inv.balance) * 100) / 100;
    if (applied <= 0) continue;
    const payDate = new Date(new Date(inv.date).getTime() + intBetween(3, 25) * 86400000);
    const when = payDate > new Date() ? new Date() : payDate;
    payments.push({
      payment_id: `${PREFIX}PAY${pNo}`,
      payment_number: `PMT-${String(500 + pNo)}`,
      customer_id: inv.customer_id,
      customer_name: inv.customer_name,
      date: isoDate(when),
      amount: applied,
      unused_amount: 0,
      bank_charges: 0,
      payment_mode: pick(PAYMENT_MODES),
      reference_number: `REF${intBetween(10000, 99999)}`,
      description: `Payment against ${inv.invoice_number}`,
      invoices: [
        {
          invoice_id: inv.invoice_id,
          invoice_number: inv.invoice_number,
          amount_applied: applied,
          date: isoDate(when),
        },
      ],
      last_modified_time: zohoTime(when),
    });
    pNo += 1;
  }
  // one current-month payment so the dashboard MTD payment tile is non-zero
  const firstCustomer = customers[0];
  payments.push({
    payment_id: `${PREFIX}PAY-MTD`,
    payment_number: `PMT-${String(500 + pNo)}`,
    customer_id: firstCustomer.contact_id,
    customer_name: firstCustomer.contact_name,
    date: isoDate(new Date()),
    amount: money(25000, 90000),
    unused_amount: 0,
    bank_charges: 0,
    payment_mode: 'banktransfer',
    reference_number: `REF${intBetween(10000, 99999)}`,
    description: 'On-account payment',
    invoices: [],
    last_modified_time: zohoTime(new Date()),
  });
  sync.upsertPayments(payments);

  // --- derived + sync_state so the Settings page has something to render ---
  sync.recomputeCustomerInvoiceDates();

  db.prepare(
    `UPDATE customers SET outstanding_receivable = (
       SELECT COALESCE(SUM(balance), 0) FROM invoices i
        WHERE i.customer_id = customers.zoho_contact_id
          AND i.status NOT IN ('void', 'draft'))`
  ).run();

  // --- phase 2: brands, rules, mapping, targets, rep assignments ----------
  const phase2 = seedPhase2(db, { customers });

  // --- phase 3: dormant customers, focus plan, cheque register ------------
  const phase3 = seedPhase3(db, { customers });

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const entity of ['salespersons', 'items', 'customers', 'invoices', 'payments']) {
    sync.updateSyncState(entity, {
      cursor: zohoTime(new Date()),
      last_run_at: now,
      last_status: 'ok',
      last_error: null,
      records_synced: 0,
      total_pending: 0,
    });
  }
  const progress = sync.lineItemProgress();
  sync.updateSyncState('invoice_details', {
    last_run_at: now,
    last_status: 'ok',
    records_synced: progress.synced,
    total_pending: progress.pending,
  });

  const counts = {
    customers: db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
    salespersons: db.prepare('SELECT COUNT(*) AS n FROM salespersons').get().n,
    items: db.prepare('SELECT COUNT(*) AS n FROM items').get().n,
    invoices: db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n,
    invoice_line_items: db.prepare('SELECT COUNT(*) AS n FROM invoice_line_items').get().n,
    payments: db.prepare('SELECT COUNT(*) AS n FROM payments').get().n,
  };

  console.log(`fake seed complete (db: ${path.relative(config.ROOT_DIR, config.DB_PATH)})`);
  console.table(counts);
  console.log(`line items: ${progress.synced}/${progress.total} invoices synced`);
  console.log(
    `brands: ${phase2.brands} · rules: ${phase2.rules} · mapped items: ${phase2.mapping.mapped} ` +
      `(${phase2.mapping.manual} manual, ${phase2.mapping.unmapped} unmapped) · targets: ${phase2.targets} ` +
      `· assignments: ${phase2.assignments.length}`
  );
  console.log(
    `cheques: ${phase3.cheques} (${phase3.dueInLeadDays} due in ${phase3.leadDays} days) · ` +
      `dormant customers seeded: ${phase3.dormantCustomers} (list at ${phase3.dormantMonths}m: ${phase3.dormantNow}) · ` +
      `focus items for ${phase3.month}: ${phase3.focus}`
  );
  return counts;
}

/**
 * Phase-2 fixtures: three brands, rules covering every rule_type (category,
 * name_pattern, sku_pattern, custom_field), two manual overrides — one that
 * shadows a rule and one on an item no rule claims — targets for the current
 * month (overall + per brand) and two reassigned customers, one 'from_today'
 * and one 'all_history'.
 */
function seedPhase2(db, { customers }) {
  const brandsService = require('../src/services/brands');
  const attribution = require('../src/services/attribution');

  // --- brands -------------------------------------------------------------
  const BRANDS = [
    ['Battalion', '#c0392b', 1],
    ['Velocity', '#2980b9', 2],
    ['Sundry', '#7f8c8d', 3],
  ];
  const brandId = {};
  for (const [name, color, order] of BRANDS) {
    db.prepare(
      `INSERT INTO brands (name, color, sort_order) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET color = excluded.color, sort_order = excluded.sort_order,
         is_active = 1, updated_at = datetime('now')`
    ).run(name, color, order);
    brandId[name] = db.prepare('SELECT id FROM brands WHERE name = ?').get(name).id;
  }

  // --- rules (re-created every seed so the ordering stays deterministic) ---
  db.prepare('DELETE FROM brand_rules').run();
  const RULES = [
    [brandId.Battalion, 'category', null, 'Frames', 10],
    [brandId.Velocity, 'name_pattern', null, '%Tyre%', 20],
    [brandId.Velocity, 'category', null, 'Components', 30],
    [brandId.Battalion, 'sku_pattern', null, 'HLM-%', 40],
    [brandId.Battalion, 'custom_field', 'Brand', 'Battalion', 50],
  ];
  const insertRule = db.prepare(
    `INSERT INTO brand_rules (brand_id, rule_type, custom_field_name, match_value, priority)
     VALUES (?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of RULES) insertRule.run(...r);
  })();

  // --- materialize, then layer the manual overrides on top ----------------
  db.prepare('DELETE FROM item_brand_map').run();
  brandsService.remapItems();

  // 'Carbon Road Fork' is Frames → Battalion by rule; the admin says Velocity.
  // A re-run must never take this back.
  const fork = db.prepare('SELECT zoho_item_id FROM items WHERE sku = ?').get('FRK-RD-CB');
  if (fork) brandsService.setItemBrand(fork.zoho_item_id, brandId.Velocity);
  // 'Bike Service Kit' matches no rule at all — mapped by hand.
  const kit = db.prepare('SELECT zoho_item_id FROM items WHERE sku = ?').get('SVC-KIT');
  if (kit) brandsService.setItemBrand(kit.zoho_item_id, brandId.Sundry);
  // 'LED Head Light' is deliberately left unmapped so the Brands page has a row.

  brandsService.remapItems(); // prove idempotency + manual preservation in the seed itself

  // --- targets for the current month --------------------------------------
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const TARGETS = [
    [REPS[0].id, null, 900000],
    [REPS[1].id, null, 750000],
    [REPS[2].id, null, 600000],
    [REPS[0].id, brandId.Battalion, 400000],
    [REPS[1].id, brandId.Velocity, 300000],
  ];
  const upsertTarget = db.prepare(
    `INSERT INTO targets (salesperson_id, month, brand_id, target_amount)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(salesperson_id, month, IFNULL(brand_id, 0))
       DO UPDATE SET target_amount = excluded.target_amount, updated_at = datetime('now')`
  );
  db.transaction(() => {
    for (const [rep, brand, amount] of TARGETS) upsertTarget.run(rep, month, brand, amount);
  })();

  // --- rep reassignments ---------------------------------------------------
  const reassigned = [
    { customer: customers[3], rep: REPS[1], mode: 'from_today', note: 'Territory swap — Priya takes over from today.' },
    { customer: customers[4], rep: REPS[2], mode: 'all_history', note: 'Account was always Rahul’s; fixing history.' },
  ];
  const assignments = [];
  for (const r of reassigned) {
    db.prepare('DELETE FROM customer_rep_assignments WHERE customer_id = ?').run(r.customer.contact_id);
    const result = attribution.assignCustomer(r.customer.contact_id, r.rep.id, r.mode, r.note);
    assignments.push({ customer: r.customer.contact_name, rep: r.rep.name, mode: r.mode, id: result.assignment.id });
  }

  return {
    brands: BRANDS.length,
    rules: RULES.length,
    mapping: brandsService.mappingStats(),
    targets: TARGETS.length,
    assignments,
    month,
  };
}

/**
 * Phase-3 fixtures.
 *
 *  * three customers whose last invoice is 5 / 8 / 6 months old (one of them
 *    Zoho-inactive) so the Dormant page has rows at the default 3-month
 *    threshold and the include-inactive toggle visibly changes the list;
 *  * a cheque register spanning every status with deposit dates from today−5
 *    to today+10 — including a cheque due exactly `cheque_lead_days` out (what
 *    the phase-4 reminder fires on) and a *deposited* cheque on the same day,
 *    which must NOT be picked up;
 *  * focus items for the current month, open and done, one of them a dormant
 *    customer so the "add to focus" round-trip has a visible end state.
 */
function seedPhase3(db, { customers }) {
  const sync = require('../src/zoho/sync');
  const chequeService = require('../src/services/cheques');
  const focusService = require('../src/services/focus');
  const dormantService = require('../src/services/dormant');
  const config2 = require('../src/config');

  const today = localIso(new Date());
  const month = today.slice(0, 7);
  const leadDays = Number(config2.getSetting('cheque_lead_days', 3)) || 3;
  const plusDays = (n) => chequeService.addDays(today, n);

  // --- dormant customers ---------------------------------------------------
  const DORMANT = [
    { idx: 11, name: 'Heritage Cycle Works', city: 'Lucknow', monthsAgo: 5, status: 'active', rep: REPS[0] },
    { idx: 12, name: 'Frontier Sports Depot', city: 'Guwahati', monthsAgo: 8, status: 'active', rep: REPS[1] },
    { idx: 13, name: 'Old Town Bicycles', city: 'Indore', monthsAgo: 6, status: 'inactive', rep: REPS[2] },
  ];

  sync.upsertCustomers(
    DORMANT.map((d) => ({
      contact_id: `${PREFIX}CUST${d.idx}`,
      contact_name: d.name,
      company_name: `${d.name} Pvt Ltd`,
      email: `${d.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.in`,
      phone: `0731-${intBetween(2000000, 4999999)}`,
      mobile: `9${intBetween(100000000, 999999999)}`,
      contact_type: 'customer',
      status: d.status,
      place_of_contact: d.city,
      currency_code: 'INR',
      payment_terms: 30,
      payment_terms_label: 'Net 30',
      outstanding_receivable: 0,
      billing_address: { address: `${intBetween(1, 90)} Station Road`, city: d.city, country: 'India' },
      shipping_address: null,
      last_modified_time: zohoTime(daysAgo(d.monthsAgo * 30)),
    }))
  );

  const dormantInvoices = DORMANT.map((d, n) => {
    const date = daysAgo(Math.round(d.monthsAgo * 30.5));
    const due = new Date(date.getTime() + 30 * 86400000);
    const total = money(45000, 180000);
    return {
      invoice_id: `${PREFIX}INV-DORM${n + 1}`,
      invoice_number: `INV-${String(3000 + n)}`,
      customer_id: `${PREFIX}CUST${d.idx}`,
      customer_name: d.name,
      salesperson_id: d.rep.id,
      salesperson_name: d.rep.name,
      date: isoDate(date),
      due_date: isoDate(due),
      status: 'overdue',
      total,
      sub_total: Math.round((total / 1.18) * 100) / 100,
      balance: n === 1 ? 0 : total, // one of them owes nothing — still dormant
      currency_code: 'INR',
      reference_number: `PO-${intBetween(100, 999)}`,
      last_modified_time: zohoTime(date),
    };
  });
  sync.upsertInvoices(dormantInvoices);
  db.prepare(
    `UPDATE invoices SET line_items_synced = 1, line_items_synced_at = datetime('now')
      WHERE zoho_invoice_id LIKE '${PREFIX}INV-DORM%'`
  ).run();

  sync.recomputeCustomerInvoiceDates();
  db.prepare(
    `UPDATE customers SET outstanding_receivable = (
       SELECT COALESCE(SUM(balance), 0) FROM invoices i
        WHERE i.customer_id = customers.zoho_contact_id
          AND i.status NOT IN ('void', 'draft'))`
  ).run();

  // --- cheque register -----------------------------------------------------
  db.prepare('DELETE FROM cheques').run();
  const CHEQUES = [
    // pending, spread across the window — the +leadDays one is what phase 4 fires on
    { customer: customers[0], days: -5, amount: 45000, status: 'pending', bank: 'HDFC Bank', note: 'Chased twice — still not deposited.' },
    { customer: customers[1], days: 0, amount: 128500, status: 'pending', bank: 'ICICI Bank' },
    { customer: customers[2], days: leadDays, amount: 76250, status: 'pending', bank: 'Axis Bank', note: 'Confirm funds before depositing.' },
    { customer: customers[3], days: leadDays, amount: 31000, status: 'deposited', bank: 'SBI' }, // same day, wrong status
    { customer: customers[4], days: 7, amount: 210000, status: 'pending', bank: 'Kotak Mahindra' },
    { customer: customers[5], days: 10, amount: 58000, status: 'pending', bank: 'Yes Bank' },
    // settled / failed history
    { customer: customers[6], days: -2, amount: 92000, status: 'deposited', bank: 'HDFC Bank' },
    { customer: customers[7], days: -4, amount: 64500, status: 'cleared', bank: 'Bank of Baroda' },
    { customer: customers[8], days: -3, amount: 38900, status: 'bounced', bank: 'PNB', note: 'Insufficient funds — re-issue requested.' },
    { customer: customers[0], days: -1, amount: 15400, status: 'cleared', bank: 'ICICI Bank' },
  ];

  let chequeNo = 400001;
  for (const c of CHEQUES) {
    const created = chequeService.createCheque({
      customer_id: c.customer.contact_id,
      amount: c.amount,
      cheque_number: String(chequeNo),
      bank_name: c.bank,
      received_date: plusDays(c.days - intBetween(3, 12)),
      deposit_date: plusDays(c.days),
      note: c.note || null,
    });
    if (c.status !== 'pending') chequeService.updateCheque(created.id, { status: c.status });
    chequeNo += 1;
  }

  // --- focus plan for the current month ------------------------------------
  db.prepare('DELETE FROM focus_plans WHERE month = ?').run(month);
  const FOCUS = [
    { id: customers[0].contact_id, note: 'Push the new frame range — reorder due.', status: 'open' },
    { id: customers[2].contact_id, note: 'Collect the overdue balance in person.', status: 'open' },
    { id: `${PREFIX}CUST11`, note: 'Dormant since spring — win the account back.', status: 'open' },
    { id: customers[5].contact_id, note: 'Store visit done; quote sent.', status: 'done' },
  ];
  for (const f of FOCUS) {
    const item = focusService.createFocus({ month, customer_id: f.id, note: f.note });
    if (f.status !== 'open') focusService.updateFocus(item.id, { status: f.status });
  }

  const dueSoon = chequeService.chequesDueInDays(leadDays);
  const dormantNow = dormantService.listDormant({}).total;

  return {
    cheques: CHEQUES.length,
    leadDays,
    dueInLeadDays: dueSoon.length,
    dormantCustomers: DORMANT.length,
    dormantMonths: dormantService.dormantMonths(),
    dormantNow,
    focus: FOCUS.length,
    month,
  };
}

if (require.main === module) {
  try {
    if (process.argv.includes('--reset-only')) {
      // wipe fake/synced data (and sync cursors) WITHOUT re-seeding — the step
      // to run right before connecting a real Zoho org
      runMigrations();
      reset(getDb());
    } else {
      seedAll({ doReset: process.argv.includes('--reset') });
    }
  } finally {
    closeDb();
  }
}

module.exports = { seedAll, PREFIX };
