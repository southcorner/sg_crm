'use strict';

/**
 * The offline stock browser: one self-contained HTML file a dealer can open on
 * a phone with no network, search, and filter by brand and category.
 *
 * This is a port of the prototype the admin approved (scratchpad/xlswork/
 * gen-html.js) — same sticky search header, same multi-token AND matching over
 * model + colours + SKUs + raw item names, same brand/category chip rows, same
 * tap-a-card-for-colours interaction, same green "Available" / amber exact
 * number, same dark-mode support. The UX is deliberately unchanged; only the
 * inputs are parameterized (exclusions, threshold, title, date) so each
 * recipient profile gets its own tailored file.
 *
 * THE SECURITY PROPERTY THAT MATTERS: masking happens HERE, at generation.
 * A quantity above the threshold is replaced by the string "Available" before
 * it is ever written, so the real number does not exist anywhere in the emitted
 * file — not in a data attribute, not in the embedded JSON, not in the search
 * haystack. Handing the file to a dealer cannot leak stock depth, whatever they
 * do with View Source. Do not add a raw quantity to the payload.
 *
 * Two escaping layers, because the payload is admin-controlled text (brand
 * names, item names) rendered into a document we ship to third parties:
 *   * `embedJson()` neutralises `</script>` and the JS line terminators, so no
 *     item name can break out of the <script> block;
 *   * the in-page renderer escapes every interpolated string before it reaches
 *     innerHTML (the prototype escaped colours only; brand and category go
 *     through the same path here).
 */

const stock = require('./stock');

const DEFAULT_THRESHOLD = 25;
/** The prototype capped the rendered list; keep it — a phone should not paint 5,000 cards. */
const RENDER_CAP = 400;

/** JSON safe to inline in a <script> block. */
function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/**
 * Flatten the brand → category → model tree into the compact row shape the
 * in-page renderer filters over.
 *
 *   b  brand      c  category   m  model name
 *   q  MASKED total            v  [{c: colour, q: MASKED}]
 *   s  search haystack (model + colours + SKUs + raw item names), uppercased
 *
 * `s` deliberately carries no quantities: it is what the search box matches on
 * and it must not become a side channel for the numbers `q` hides.
 */
function buildRows(tree, threshold) {
  const rows = [];
  for (const brand of tree.brands) {
    for (const cat of brand.categories) {
      for (const model of cat.models) {
        const haystack = [
          model.model,
          ...model.colors.map((c) => c.color),
          ...model.colors.flatMap((c) => c.items.map((i) => `${i.sku} ${i.name}`)),
        ]
          .join(' ')
          .toUpperCase();

        rows.push({
          b: brand.name,
          c: cat.name,
          m: model.model,
          q: stock.maskQty(model.total, threshold),
          s: haystack,
          v: model.colors.map((c) => ({ c: c.color, q: stock.maskQty(c.afs, threshold) })),
        });
      }
    }
  }
  return rows;
}

const PAGE_CSS = `
  :root { --ink:#1c2733; --sub:#5b6975; --line:#e3e8ee; --bg:#f6f8fa; --card:#ffffff; --accent:#0b62d6; --chipbg:#e9eef5; }
  * { box-sizing:border-box; margin:0; }
  body { font:15px/1.45 -apple-system,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  header { position:sticky; top:0; background:var(--card); border-bottom:1px solid var(--line); padding:10px 12px 8px; z-index:5; }
  h1 { font-size:15px; margin-bottom:8px; } h1 small { color:var(--sub); font-weight:400; }
  #q { width:100%; font-size:16px; padding:10px 12px; border:1.5px solid var(--line); border-radius:10px; outline:none; }
  #q:focus { border-color:var(--accent); }
  .chips { display:flex; gap:6px; overflow-x:auto; padding:8px 0 2px; -webkit-overflow-scrolling:touch; }
  .chip { flex:0 0 auto; font-size:13px; padding:5px 11px; border-radius:999px; background:var(--chipbg); color:var(--ink); border:none; }
  .chip.on { background:var(--accent); color:#fff; }
  #count { font-size:12.5px; color:var(--sub); padding:6px 14px; }
  #list { padding:0 10px 30px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; margin-bottom:8px; padding:10px 12px; }
  .top { display:flex; justify-content:space-between; gap:10px; align-items:baseline; }
  .model { font-weight:600; }
  .qty { font-weight:700; white-space:nowrap; color:#0a7a3d; }
  .qty.low { color:#b3541e; }
  .meta { font-size:12px; color:var(--sub); margin-top:2px; }
  .colors { margin-top:6px; display:none; border-top:1px dashed var(--line); padding-top:6px; }
  .card.open .colors { display:block; }
  .cr { display:flex; justify-content:space-between; font-size:13.5px; padding:2px 0; color:var(--sub); }
  .cr b { color:var(--ink); font-weight:500; }
  .empty { text-align:center; color:var(--sub); padding:40px 0; }
  .foot { text-align:center; color:var(--sub); font-size:11.5px; padding:0 16px 26px; line-height:1.6; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e8edf2; --sub:#95a3b0; --line:#2b3947; --bg:#101820; --card:#1a2530; --chipbg:#243240; }
    .qty { color:#4cc38a; } .qty.low { color:#e8a06a; }
  }`;

/** The in-page app. Kept as a plain string so nothing here is ever bundled. */
function pageScript(rows, brands, cats, cap) {
  return `
const DATA = ${embedJson(rows)};
const BRANDS = ${embedJson(brands)};
const CATS = ${embedJson(cats)};
const CAP = ${cap};
let brand = '', cat = '', q = '';

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function chips(el, values, get, set) {
  el.innerHTML = '';
  const all = document.createElement('button');
  all.className = 'chip' + (get() === '' ? ' on' : '');
  all.textContent = 'All';
  all.onclick = () => { set(''); render(); };
  el.appendChild(all);
  for (const v of values) {
    const b = document.createElement('button');
    b.className = 'chip' + (get() === v ? ' on' : '');
    b.textContent = v;
    b.onclick = () => { set(get() === v ? '' : v); render(); };
    el.appendChild(b);
  }
}

function render() {
  chips(document.getElementById('brandChips'), BRANDS, () => brand, (v) => (brand = v));
  chips(document.getElementById('catChips'), CATS, () => cat, (v) => (cat = v));
  const toks = q.toUpperCase().split(/\\s+/).filter(Boolean);
  const hits = DATA.filter((d) =>
    (!brand || d.b === brand) && (!cat || d.c === cat) && toks.every((t) => d.s.includes(t))
  );
  document.getElementById('count').textContent =
    hits.length + ' model' + (hits.length === 1 ? '' : 's') +
    (brand ? ' \\u00b7 ' + brand : '') + (cat ? ' \\u00b7 ' + cat : '') + (q ? ' \\u00b7 "' + q + '"' : '') +
    (hits.length > CAP ? ' (showing first ' + CAP + ')' : '');
  const list = document.getElementById('list');
  list.innerHTML = '';
  if (!hits.length) { list.innerHTML = '<div class="empty">No matching models</div>'; return; }
  for (const d of hits.slice(0, CAP)) {
    const card = document.createElement('div');
    card.className = 'card';
    const low = d.q !== 'Available';
    card.innerHTML =
      '<div class="top"><span class="model"></span><span class="qty' + (low ? ' low' : '') + '"></span></div>' +
      '<div class="meta">' + esc(d.b) + ' \\u00b7 ' + esc(d.c) + '</div>' +
      '<div class="colors">' + d.v.map((v) =>
        '<div class="cr"><b>' + esc(v.c) + '</b><span>' + esc(v.q) + '</span></div>').join('') + '</div>';
    card.querySelector('.model').textContent = d.m;
    card.querySelector('.qty').textContent = d.q;
    card.onclick = () => card.classList.toggle('open');
    list.appendChild(card);
  }
}

document.getElementById('q').addEventListener('input', (e) => { q = e.target.value; render(); });
render();`;
}

/**
 * Generate the file.
 *
 * @param {object}   opts
 * @param {number[]} [opts.excludedBrands]     brand ids to omit (0 = Unbranded)
 * @param {string[]} [opts.excludedCategories] display category names to omit
 * @param {number}   [opts.threshold]          mask above this (inclusive boundary)
 * @param {string}   [opts.date]               stamp shown in the header
 * @param {string}   [opts.title]              document title / heading
 * @returns {{html, filename, counts, brands, categories, threshold, date}}
 */
function generate({
  excludedBrands = [],
  excludedCategories = [],
  threshold = DEFAULT_THRESHOLD,
  date = new Date().toISOString().slice(0, 10),
  title = null,
  db = undefined,
} = {}) {
  const tree = stock.buildStock({ excludedBrands, excludedCategories, ...(db ? { db } : {}) });
  const rows = buildRows(tree, threshold);

  // brand order follows the tree (brands-table order, Unbranded last);
  // categories are alphabetical, as in the prototype
  const brands = tree.brands.map((b) => b.name).filter((name) => rows.some((r) => r.b === name));
  const cats = [...new Set(rows.map((r) => r.c))].sort();

  const heading = title || 'Stock availability';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(heading)} ${escHtml(date)}</title>
<style>${PAGE_CSS}
</style>
</head>
<body>
<header>
  <h1>${escHtml(heading)} <small>· ${escHtml(date)} · tap a model for colours</small></h1>
  <input id="q" type="search" placeholder="Search model, colour or SKU…" autocomplete="off">
  <div class="chips" id="brandChips"></div>
  <div class="chips" id="catChips"></div>
</header>
<div id="count"></div>
<div id="list"></div>
<p class="foot">Quantities above ${escHtml(String(threshold))} are shown as “Available”.<br>Works offline — save this file and open it any time.</p>
<script>${pageScript(rows, brands, cats, RENDER_CAP)}
</script>
</body>
</html>`;

  return {
    html,
    filename: `Stock ${date}.html`,
    date,
    threshold,
    counts: { ...tree.counts, rows: rows.length },
    brands,
    categories: cats,
    excluded: tree.excluded,
  };
}

module.exports = {
  DEFAULT_THRESHOLD,
  RENDER_CAP,
  embedJson,
  escHtml,
  buildRows,
  generate,
};
