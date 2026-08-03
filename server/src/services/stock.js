'use strict';

/**
 * In-stock items, grouped into models with colour variants merged.
 *
 * The tokenizer / colour vocabulary / modelKey / canonical-merge logic below is
 * a straight port of the script that was iterated against the real Item export
 * (scratchpad/xlswork/grouping.js). Its behaviour is deliberately preserved —
 * the vocabularies and the exact drop rules are what make
 *
 *   "Z POWER 800 RP+ RED- MATT UNSTRUNG - 4U"  and
 *   "Z POWER 800 RP+ BLACK - MATT UNSTRUNG 4U"
 *
 * land in one model while "...5U" stays its own, and "FINAPI 232 XTRA POWER"
 * never collapses into "FINAPI 232". Change the vocabularies and you change the
 * report; there are fixture tests pinning exactly these cases.
 *
 * Only the INPUT was adapted. The original read an xlsx; this reads the synced
 * `items` table. What the live Zoho org actually returns (verified against
 * data/crm.db, 3,612 items):
 *
 *   * custom fields are NOT a `custom_fields` array — the list API flattens
 *     them to top-level `cf_<slug>` keys: `cf_color` (3,073 items),
 *     `cf_item_category` (2,894), `cf_size` (1,312), `cf_style` (618),
 *     `cf_official_color_name` (328). `items.custom_fields_json` is empty; it
 *     is never populated by the list sync.
 *   * there is NO product-name field of any kind. The xlsx had a "Product Name"
 *     column that taught the canonical merge a broader, brand-prefixed title
 *     ("Apacs Z-Ziggler"); the API has no equivalent, so that vote map simply
 *     stays empty and the display name falls back to titleCase(modelKey). The
 *     grouping itself is unaffected — it only ever keyed off the item name.
 *     `cf_style` is deliberately NOT used as a stand-in: it holds style codes
 *     like "SPEED 77", which would corrupt the merge.
 *
 * Brand comes from item_brand_map → brands (the mapping the admin curates on
 * the Brands page), not from anything in the Zoho payload.
 */

const { getDb } = require('../db/connection');

// ---- colour / noise vocabulary (ported verbatim) ---------------------------
const COLORS = new Set([
  'BLACK', 'WHITE', 'RED', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE',
  'PINK', 'GREY', 'GRAY', 'GOLD', 'GOLDEN', 'SILVER', 'NAVY', 'MAROON',
  'CYAN', 'LIME', 'CARMINE', 'TURQUOISE', 'VIOLET', 'BROWN', 'BEIGE',
  'MAGENTA', 'CHARCOAL', 'TEAL', 'OLIVE', 'CREAM', 'MINT', 'PEACH', 'CORAL',
  'LAVENDER', 'MULTICOLOR', 'MULTICOLOUR', 'MULTI', 'FLUORESCENT', 'NEON',
  'BLK', 'WHT', 'ORG', 'GRN', 'YLW', 'YEL', 'PUR', 'GRY', 'TURQ', 'NVY',
  'MRN', 'WINE', 'SAPPHIRE', 'RUBY', 'EMERALD',
]);
const COLOR_MODIFIERS = new Set(['LIGHT', 'DARK', 'MATT', 'MATTE', 'GLOSSY', 'GLOSS', 'SHINY', 'NEW', 'ROYAL', 'L', 'D']);
const NOISE = new Set([
  'UNSTRUNG', 'STRUNG', 'REGULAR', 'CUSTOM',
  'MATT', 'MATTE', 'GLOSSY', 'GLOSS', 'GLO', 'SHINY',
]);
const SIZE_TOKENS = new Set(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL', 'FREE', 'FREESIZE']);

const COLOR_ALIASES = { BLK: 'BLACK', WHT: 'WHITE', ORG: 'ORANGE', GRN: 'GREEN', YLW: 'YELLOW', PUR: 'PURPLE', GRY: 'GREY', GRAY: 'GREY' };

function tokenize(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')      // drop paren content: (Matt), (CP2022)
    .replace(/[\/,+&.\-]/g, ' ')      // BLK/YELLOW, BLK-MATT, RED-, Z-POWER vs Z POWER
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Strip colour runs, finishes, strung-status, sizes; keep real model words. */
function modelKey(name) {
  const toks = tokenize(name);
  const kept = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (NOISE.has(t)) continue;
    if (SIZE_TOKENS.has(t) && i > 0) continue; // sizes never lead a name
    if (COLORS.has(t)) continue;
    if (COLOR_MODIFIERS.has(t)) {
      // drop only when attached to a colour word (LIGHT BLUE / NEW RED / DARK GREY)
      const next = toks[i + 1];
      const prev = toks[i - 1];
      if ((next && (COLORS.has(next) || COLOR_MODIFIERS.has(next))) || (prev && COLORS.has(prev))) continue;
    }
    if (/^UK\d+$/.test(t) || /^EU\d+$/.test(t)) continue;
    kept.push(t);
  }
  return kept.join(' ').trim();
}

/** True when a name carries no colour/finish/strung tokens at all. */
function isCleanName(s) {
  return tokenize(s).every((t) => !COLORS.has(t) && !NOISE.has(t) && !COLOR_MODIFIERS.has(t));
}

function normalizeColor(c) {
  if (!c) return '';
  const toks = tokenize(c).filter((t) => !NOISE.has(t));
  if (!toks.length) return '';
  return toks.map((t) => COLOR_ALIASES[t] || t).join(' ');
}

function colorFromName(name) {
  const toks = tokenize(name);
  const found = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (COLORS.has(t)) {
      const prev = toks[i - 1];
      if (prev && COLOR_MODIFIERS.has(prev) && !found.includes(prev)) found.push(prev);
      found.push(t);
    }
  }
  return normalizeColor(found.join(' '));
}

function mode(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(\d+[a-z]*)\b/gi, (m) => m.toUpperCase());
}

// ---- grouping (ported verbatim) --------------------------------------------

/**
 * Merge items into models. Colour variants of one racket collapse into a single
 * row with per-colour sub-rows; genuinely different sub-models stay apart.
 *
 * @param {Array<{id,name,sku,productName,color,size,category,afs}>} items
 */
function groupItems(items) {
  // canonical map: normalized item key -> {fullKey, votes} learned from items
  // whose Product Name is broader than the item name (e.g. brand-prefixed).
  // On the live Zoho data there is no product name, so this stays empty and
  // every group keeps its own key — see the module header.
  const canonicalVotes = new Map(); // key -> Map(fullKey -> count)
  for (const it of items) {
    const k = modelKey(it.name);
    const pk = modelKey(it.productName);
    if (!k || !pk || pk === k) continue;
    if (pk.endsWith(' ' + k) || pk === k) {
      if (!canonicalVotes.has(k)) canonicalVotes.set(k, new Map());
      const m = canonicalVotes.get(k);
      m.set(pk, (m.get(pk) || 0) + 1);
    }
  }
  const canonical = new Map();
  for (const [k, votes] of canonicalVotes) {
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    canonical.set(k, best);
  }

  const groups = new Map(); // groupKey -> {displayVotes, items}
  for (const it of items) {
    const k = modelKey(it.name) || modelKey(it.productName) || String(it.name).toUpperCase();
    const gk = canonical.get(k) || k;
    if (!groups.has(gk)) groups.set(gk, { displayVotes: new Map(), items: [] });
    const g = groups.get(gk);
    g.items.push(it);
    // display name: prefer a raw Product Name that maps to this group AND is
    // itself clean (no colour/finish words) — e.g. "Apacs Z-Ziggler"; a name
    // like "Z-ZIGGLER REBORN BLUE MATTE UNSTRUNG" must not become the title
    const pn = it.productName;
    if (pn && modelKey(pn) === gk && isCleanName(pn)) {
      g.displayVotes.set(pn, (g.displayVotes.get(pn) || 0) + 1);
    }
  }

  const out = [];
  for (const [gk, g] of groups) {
    const display = [...g.displayVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || titleCase(gk);
    // colour sub-groups: prefer the Colour custom field; fall back to colour
    // words found in the item name
    const colors = new Map();
    for (const it of g.items) {
      const c = normalizeColor(it.color) || colorFromName(it.name) || '(unspecified)';
      if (!colors.has(c)) colors.set(c, { afs: 0, items: [] });
      colors.get(c).afs += it.afs;
      colors.get(c).items.push(it);
    }
    out.push({
      key: gk,
      model: display,
      total: g.items.reduce((s, i) => s + i.afs, 0),
      itemCount: g.items.length,
      category: mode(g.items.map((i) => i.category).filter(Boolean)) || '',
      colors: [...colors.entries()]
        .map(([color, v]) => ({ color, afs: v.afs, items: v.items }))
        .sort((a, b) => b.afs - a.afs || String(a.color).localeCompare(String(b.color))),
    });
  }
  out.sort((a, b) => b.total - a.total || String(a.model).localeCompare(String(b.model)));
  return out;
}

// ---- loading ---------------------------------------------------------------

// ---- masking ---------------------------------------------------------------

/**
 * THE masking rule, shared by the email body and the HTML attachment so the two
 * can never disagree. Above the threshold a dealer learns only that we have it;
 * at or below it they see exactly how little is left, which is the number worth
 * acting on. The boundary is inclusive — threshold 25 prints "25" for 25.
 */
const MASK_LABEL = 'Available';

/** Stock can be fractional (line sold by weight) — never print 4038.0000001. */
function formatQty(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return String(v);
}

function maskQty(qty, threshold) {
  const n = Number(qty) || 0;
  return n > threshold ? MASK_LABEL : formatQty(n);
}

/** Category display rules: Bags reads as Kitbag, and blank is its own bucket. */
const CATEGORY_RENAMES = { Bags: 'Kitbag' };
const CATEGORY_FALLBACK = 'Other';

function displayCategory(raw) {
  const value = String(raw || '').trim();
  if (!value) return CATEGORY_FALLBACK;
  return CATEGORY_RENAMES[value] || value;
}

/** The brand bucket for items no rule or override has claimed. */
const UNBRANDED = { id: 0, name: 'Unbranded' };

/**
 * Every active item with stock, decorated with its brand and custom fields.
 * Read-only; safe to call as often as the UI likes.
 */
function loadStockItems({ db = getDb() } = {}) {
  const rows = db
    .prepare(
      `SELECT i.zoho_item_id AS id, i.name, i.sku, i.raw_json,
              b.id AS brand_id, b.name AS brand_name, b.sort_order AS brand_sort
         FROM items i
         LEFT JOIN item_brand_map m ON m.item_id = i.zoho_item_id
         LEFT JOIN brands b ON b.id = m.brand_id AND b.is_active = 1
        WHERE i.status = 'active'
          AND i.raw_json IS NOT NULL
          AND json_extract(i.raw_json, '$.available_for_sale') > 0`
    )
    .all();

  const items = [];
  for (const row of rows) {
    let j;
    try {
      j = JSON.parse(row.raw_json);
    } catch (_err) {
      continue; // an unparsable payload is a sync bug, not a reason to fail the report
    }
    const afs = Number(j.available_for_sale);
    if (!Number.isFinite(afs) || afs <= 0) continue;

    items.push({
      id: String(row.id),
      name: String(row.name || j.name || '').trim(),
      sku: String(row.sku || j.sku || '').trim(),
      // no product-name field exists on the live payload — see the module header
      productName: '',
      color: String(j.cf_color || j.cf_official_color_name || '').trim(),
      size: String(j.cf_size || '').trim(),
      category: String(j.cf_item_category || '').trim(),
      afs,
      brandId: row.brand_id === null ? UNBRANDED.id : row.brand_id,
      brandName: row.brand_id === null ? UNBRANDED.name : row.brand_name,
      brandSort: row.brand_id === null ? Number.MAX_SAFE_INTEGER : Number(row.brand_sort || 0),
    });
  }
  return items;
}

/** Every category currently present in stock — the Settings exclusion list. */
function availableCategories({ db = getDb() } = {}) {
  const counts = new Map();
  for (const it of loadStockItems({ db })) {
    const c = displayCategory(it.category);
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, items]) => ({ name, items }))
    .sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));
}

/** Brands offered in the Settings exclusion list, including the Unbranded bucket. */
function availableBrands({ db = getDb() } = {}) {
  const rows = db
    .prepare('SELECT id, name, sort_order FROM brands WHERE is_active = 1 ORDER BY sort_order ASC, name ASC')
    .all()
    .map((b) => ({ id: b.id, name: b.name }));
  return [...rows, { ...UNBRANDED }];
}

/**
 * The full report tree: brand → category → models (with colour sub-rows).
 *
 * Grouping runs WITHIN a brand: two brands may legitimately ship a model whose
 * name normalizes the same way, and merging them would invent a product.
 *
 * @param {object}   opts
 * @param {number[]} [opts.excludedBrands]      brand ids to omit (0 = Unbranded)
 * @param {string[]} [opts.excludedCategories]  display category names to omit
 */
function buildStock({ excludedBrands = [], excludedCategories = [], db = getDb() } = {}) {
  const skipBrand = new Set((excludedBrands || []).map(Number));
  const skipCategory = new Set((excludedCategories || []).map((c) => String(c)));

  const all = loadStockItems({ db });
  const byBrand = new Map();
  for (const it of all) {
    if (skipBrand.has(Number(it.brandId))) continue;
    if (skipCategory.has(displayCategory(it.category))) continue;
    if (!byBrand.has(it.brandId)) {
      byBrand.set(it.brandId, { id: it.brandId, name: it.brandName, sort: it.brandSort, items: [] });
    }
    byBrand.get(it.brandId).items.push(it);
  }

  const brands = [];
  let modelCount = 0;
  let itemCount = 0;
  let unitCount = 0;

  for (const bucket of [...byBrand.values()].sort(
    (a, b) => a.sort - b.sort || String(a.name).localeCompare(String(b.name))
  )) {
    const models = groupItems(bucket.items);
    const byCategory = new Map();
    for (const model of models) {
      const cat = displayCategory(model.category);
      if (!byCategory.has(cat)) byCategory.set(cat, { name: cat, models: [], total: 0 });
      const entry = byCategory.get(cat);
      entry.models.push(model);
      entry.total += model.total;
    }

    const categories = [...byCategory.values()].sort(
      (a, b) => b.total - a.total || a.name.localeCompare(b.name)
    );
    const brandTotal = categories.reduce((s, c) => s + c.total, 0);
    const brandModels = categories.reduce((s, c) => s + c.models.length, 0);

    modelCount += brandModels;
    itemCount += bucket.items.length;
    unitCount += brandTotal;

    brands.push({
      id: bucket.id,
      name: bucket.name,
      categories,
      models: brandModels,
      items: bucket.items.length,
      total: brandTotal,
    });
  }

  return {
    brands,
    counts: { brands: brands.length, models: modelCount, items: itemCount, units: unitCount },
    excluded: { brands: [...skipBrand], categories: [...skipCategory] },
  };
}

module.exports = {
  COLORS,
  COLOR_MODIFIERS,
  NOISE,
  SIZE_TOKENS,
  CATEGORY_RENAMES,
  CATEGORY_FALLBACK,
  UNBRANDED,
  MASK_LABEL,
  formatQty,
  maskQty,
  tokenize,
  modelKey,
  isCleanName,
  normalizeColor,
  colorFromName,
  titleCase,
  mode,
  groupItems,
  displayCategory,
  loadStockItems,
  availableCategories,
  availableBrands,
  buildStock,
};
