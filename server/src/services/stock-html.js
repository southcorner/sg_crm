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
 *   * the in-page renderer builds every node with `textContent` and never puts
 *     a payload string near innerHTML at all (the prototype escaped colours
 *     only, and escaping is easy to forget when a field is added).
 *
 * Two things sit on top of that base:
 *   * ITEM PHOTOS — 128px JPEG thumbnails from services/item-images.js, inlined
 *     as data URIs on colour rows, deduplicated into an IMG table because one
 *     picture is typically shared by every size of a garment. A model with no
 *     cached picture renders exactly as it always did: no placeholder, no gap.
 *   * SIZES — jersey categories get a Model → Size → Colour hierarchy, because
 *     "which sizes are left" is the question a dealer asks about a garment and
 *     not one they ask about a racket. Everything else keeps Model → Colour.
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

// ---------------------------------------------------------------------------
// sizes (jersey categories only)
// ---------------------------------------------------------------------------

/** Categories that get the extra Model → Size → Colour level. */
const SIZED_CATEGORIES = new Set(['Badminton Jersey', 'Cycling Jersey']);
const FREE_SIZE = 'Free size';

/**
 * Garment sizes in the order a human expects, not alphabetically. Both spellings
 * of the doubled sizes rank together because the live data uses "2XL" while
 * people say "XXL". Anything unrecognised sorts after the known run, by name.
 */
const SIZE_RANK = {
  '3XS': -3, XXXS: -3,
  '2XS': -2, XXS: -2,
  XS: -1,
  S: 0,
  M: 1,
  L: 2,
  XL: 3,
  '2XL': 4, XXL: 4,
  '3XL': 5, XXXL: 5,
  '4XL': 6, XXXXL: 6,
  '5XL': 7,
};

/** A size token, if the tail of an item name looks like one. */
function parseSizeFromName(name) {
  const toks = stock.tokenize(name);
  for (let i = toks.length - 1; i >= 0 && i >= toks.length - 3; i -= 1) {
    const t = toks[i];
    if (Object.prototype.hasOwnProperty.call(SIZE_RANK, t)) return t;
    if (t === 'FREE' || t === 'FREESIZE') return FREE_SIZE;
  }
  return null;
}

/** The size an item belongs to: the custom field, else the name, else free. */
function itemSize(item) {
  const declared = String(item.size || '').trim().toUpperCase();
  if (declared) return declared;
  return parseSizeFromName(item.name) || FREE_SIZE;
}

function compareSizes(a, b) {
  const ra = SIZE_RANK[a];
  const rb = SIZE_RANK[b];
  if (ra !== undefined && rb !== undefined) return ra - rb || a.localeCompare(b);
  if (ra !== undefined) return -1;
  if (rb !== undefined) return 1;
  return a.localeCompare(b);
}

/**
 * Regroup one model's items as size → colour. Used for jerseys only, where
 * "which sizes are left" is the question a dealer actually asks.
 *
 * Model identity is untouched: services/stock.js still strips size tokens when
 * it builds the model key, so a Polo in S and in XL remain ONE model — the
 * sizes are recovered here, at composition time, from each item's own fields.
 */
function sizeGroups(model, threshold, imageIndex) {
  const bySize = new Map();
  for (const colour of model.colors) {
    for (const item of colour.items) {
      const size = itemSize(item);
      if (!bySize.has(size)) bySize.set(size, { size, total: 0, colours: new Map() });
      const group = bySize.get(size);
      group.total += item.afs;
      if (!group.colours.has(colour.color)) group.colours.set(colour.color, { colour: colour.color, afs: 0, items: [] });
      const entry = group.colours.get(colour.color);
      entry.afs += item.afs;
      entry.items.push(item);
    }
  }

  return [...bySize.values()]
    .sort((a, b) => compareSizes(a.size, b.size))
    .map((group) => ({
      s: group.size,
      q: stock.maskQty(group.total, threshold),
      v: [...group.colours.values()]
        .sort((a, b) => b.afs - a.afs || String(a.colour).localeCompare(String(b.colour)))
        .map((c) => colourRow(c.colour, c.afs, c.items, threshold, imageIndex)),
    }));
}

/** One colour line: name, masked quantity, and an image index when we have one. */
function colourRow(colour, afs, items, threshold, imageIndex) {
  const row = { c: colour, q: stock.maskQty(afs, threshold) };
  if (imageIndex) {
    // a colour aggregates several items; the first one that HAS a picture wins
    for (const item of items) {
      const idx = imageIndex.indexOf(item.id);
      if (idx !== undefined) {
        row.i = idx;
        break;
      }
    }
  }
  return row;
}

/**
 * Builds the deduplicated image table. Two items can easily carry the same
 * picture (a jersey photographed once, listed per size), and the same data URI
 * repeated 8 times is 8x the bytes for no benefit — so identical thumbnails
 * collapse to one entry and rows reference it by index.
 */
function makeImageIndex(thumbs) {
  const uris = [];
  const byUri = new Map();
  const byItem = new Map();

  return {
    /** @returns {number|undefined} index into the emitted IMG array */
    indexOf(itemId) {
      const key = String(itemId);
      if (byItem.has(key)) return byItem.get(key);
      const uri = thumbs.get(key);
      if (!uri) return undefined;
      let idx = byUri.get(uri);
      if (idx === undefined) {
        idx = uris.length;
        uris.push(uri);
        byUri.set(uri, idx);
      }
      byItem.set(key, idx);
      return idx;
    },
    uris,
  };
}

/**
 * Flatten the brand → category → model tree into the compact row shape the
 * in-page renderer filters over.
 *
 *   b  brand      c  category   m  model name
 *   q  MASKED total
 *   v  [{c: colour, q: MASKED, i?: image index}]   — non-jersey models
 *   z  [{s: size, q: MASKED, v: [colour rows]}]    — jersey models
 *   s  search haystack (model + colours + SIZES + SKUs + raw item names)
 *
 * `s` deliberately carries no quantities: it is what the search box matches on
 * and it must not become a side channel for the numbers `q` hides. Sizes ARE in
 * it, so "polo xl" finds the model.
 */
function buildRows(tree, threshold, imageIndex = null) {
  const rows = [];
  for (const brand of tree.brands) {
    for (const cat of brand.categories) {
      const sized = SIZED_CATEGORIES.has(cat.name);
      for (const model of cat.models) {
        const items = model.colors.flatMap((c) => c.items);
        const haystack = [
          model.model,
          ...model.colors.map((c) => c.color),
          ...items.map((i) => `${i.sku} ${i.name}`),
          ...new Set(items.map((i) => itemSize(i))),
        ]
          .join(' ')
          .toUpperCase();

        const row = {
          b: brand.name,
          c: cat.name,
          m: model.model,
          q: stock.maskQty(model.total, threshold),
          s: haystack,
        };
        if (sized) row.z = sizeGroups(model, threshold, imageIndex);
        else {
          row.v = model.colors.map((c) => colourRow(c.color, c.afs, c.items, threshold, imageIndex));
        }
        rows.push(row);
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
  .cr { display:flex; align-items:center; gap:8px; font-size:13.5px; padding:3px 0; color:var(--sub); }
  .cr b { color:var(--ink); font-weight:500; flex:1; min-width:0; }
  .cr span { white-space:nowrap; }
  /* the row thumbnail is a tap target in its own right — hence the size bump
     from 34 to 44, the zoom cursor and the press feedback */
  .thumb { width:44px; height:44px; flex:0 0 auto; object-fit:cover; border-radius:6px;
           background:var(--chipbg); cursor:zoom-in; transition:transform .12s; }
  .thumb:active { transform:scale(.94); }
  /* --- lightbox: one overlay reused by every picture --- */
  #lb { position:fixed; inset:0; z-index:50; display:none; background:rgba(8,12,16,.92);
        align-items:center; justify-content:center; flex-direction:column; gap:14px; padding:16px; }
  #lb.on { display:flex; }
  #lb img { max-width:92vw; max-height:80vh; border-radius:10px; background:#0d1319;
            box-shadow:0 10px 40px rgba(0,0,0,.5); }
  #lbcap { color:#e8edf2; font-size:14px; text-align:center; max-width:92vw; line-height:1.4; }
  #lbcap small { display:block; color:#95a3b0; font-size:12px; margin-top:2px; }
  #lbx { position:absolute; top:8px; right:8px; width:44px; height:44px; border:0; border-radius:50%;
         background:rgba(255,255,255,.14); color:#fff; font-size:22px; line-height:44px; padding:0;
         cursor:pointer; }
  #lbx:active { background:rgba(255,255,255,.28); }
  body.lb-open { overflow:hidden; }
  /* jersey level 2: size rows, each opening independently of its siblings */
  .sz { border-top:1px solid var(--line); }
  .sz:first-child { border-top:0; }
  .sz-head { display:flex; align-items:center; gap:8px; min-height:40px; padding:4px 0; cursor:pointer; font-size:13.5px; }
  .sz-head b { flex:1; color:var(--ink); font-weight:600; }
  .sz-head .szq { color:var(--sub); white-space:nowrap; }
  .caret { color:var(--sub); font-size:11px; transition:transform .12s; width:12px; text-align:center; }
  .sz.open .caret { transform:rotate(90deg); }
  .sz-body { display:none; padding:2px 0 8px 12px; }
  .sz.open .sz-body { display:block; }
  .empty { text-align:center; color:var(--sub); padding:40px 0; }
  .foot { text-align:center; color:var(--sub); font-size:11.5px; padding:0 16px 26px; line-height:1.6; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e8edf2; --sub:#95a3b0; --line:#2b3947; --bg:#101820; --card:#1a2530; --chipbg:#243240; }
    .qty { color:#4cc38a; } .qty.low { color:#e8a06a; }
  }`;

/** The in-page app. Kept as a plain string so nothing here is ever bundled. */
function pageScript(rows, brands, cats, cap, images) {
  return `
const DATA = ${embedJson(rows)};
const BRANDS = ${embedJson(brands)};
const CATS = ${embedJson(cats)};
const IMG = ${embedJson(images)};
const CAP = ${cap};
let brand = '', cat = '', q = '';

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
  const frag = document.createDocumentFragment();
  for (const d of hits.slice(0, CAP)) frag.appendChild(buildCard(d));
  list.appendChild(frag);
}

/** Every node is built with textContent — no user string ever reaches innerHTML. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function colourRow(v, model) {
  const row = el('div', 'cr');
  if (v.i !== undefined && IMG[v.i]) {
    const img = el('img', 'thumb');
    img.src = IMG[v.i];
    img.alt = v.c;
    img.loading = 'lazy';
    // the picture is its own tap target: opening it must not also toggle the
    // row or the card underneath it
    img.onclick = (e) => { e.stopPropagation(); openLightbox(IMG[v.i], model, v.c); };
    row.appendChild(img);
  }
  row.appendChild(el('b', null, v.c));
  row.appendChild(el('span', null, v.q));
  return row;
}

/* --- lightbox ---------------------------------------------------------- */
const lb = document.getElementById('lb');
const lbImg = document.getElementById('lbimg');
const lbCap = document.getElementById('lbcap');

function openLightbox(src, model, colour) {
  lbImg.src = src;
  lbImg.alt = model + ' ' + colour;
  lbCap.textContent = model;
  const sub = document.createElement('small');
  sub.textContent = colour;
  lbCap.appendChild(sub);
  lb.classList.add('on');
  // a phone must not scroll the list behind the overlay
  document.body.classList.add('lb-open');
}

function closeLightbox() {
  lb.classList.remove('on');
  document.body.classList.remove('lb-open');
  // drop the data URI so the browser can release it
  lbImg.removeAttribute('src');
}

document.getElementById('lbx').onclick = closeLightbox;
// a tap on the backdrop closes; a tap on the picture itself does not
lb.onclick = (e) => { if (e.target === lb || e.target === lbCap) closeLightbox(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lb.classList.contains('on')) closeLightbox(); });

function buildCard(d) {
  const card = el('div', 'card');
  const top = el('div', 'top');
  top.appendChild(el('span', 'model', d.m));
  top.appendChild(el('span', 'qty' + (d.q !== 'Available' ? ' low' : ''), d.q));
  card.appendChild(top);
  card.appendChild(el('div', 'meta', d.b + ' \\u00b7 ' + d.c));

  const colors = el('div', 'colors');
  if (d.z) {
    // jerseys: a size level between the model and its colours. Each size opens
    // on its own, and the click must not bubble up and shut the whole card.
    for (const sz of d.z) {
      const wrap = el('div', 'sz');
      const head = el('div', 'sz-head');
      head.appendChild(el('span', 'caret', '\\u25b8'));
      head.appendChild(el('b', null, sz.s));
      head.appendChild(el('span', 'szq', sz.q));
      const body = el('div', 'sz-body');
      for (const v of sz.v) body.appendChild(colourRow(v, d.m));
      head.onclick = (e) => { e.stopPropagation(); wrap.classList.toggle('open'); };
      wrap.appendChild(head);
      wrap.appendChild(body);
      colors.appendChild(wrap);
    }
  } else {
    for (const v of d.v) colors.appendChild(colourRow(v, d.m));
  }

  card.appendChild(colors);
  card.onclick = () => card.classList.toggle('open');
  return card;
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
  includeImages = true,
  thumbnails = null,
  db = undefined,
} = {}) {
  const tree = stock.buildStock({ excludedBrands, excludedCategories, ...(db ? { db } : {}) });

  // Thumbnails are looked up once for the whole file; `includeImages: false`
  // skips the cache read entirely, which is also what the size guardrail uses
  // to regenerate a too-large file.
  let thumbs = new Map();
  if (includeImages) {
    if (thumbnails instanceof Map) thumbs = thumbnails;
    else if (thumbnails) thumbs = new Map(Object.entries(thumbnails));
    else {
      try {
        thumbs = require('./item-images').loadThumbnails({ ...(db ? { db } : {}) });
      } catch (err) {
        // a broken image cache must never cost the dealer their stock list
        thumbs = new Map();
      }
    }
  }
  const imageIndex = thumbs.size ? makeImageIndex(thumbs) : null;
  const rows = buildRows(tree, threshold, imageIndex);
  const images = imageIndex ? imageIndex.uris : [];

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
  <h1>${escHtml(heading)} <small>· ${escHtml(date)} · tap a model for details, a photo to enlarge</small></h1>
  <input id="q" type="search" placeholder="Search model, colour or SKU…" autocomplete="off">
  <div class="chips" id="brandChips"></div>
  <div class="chips" id="catChips"></div>
</header>
<div id="count"></div>
<div id="list"></div>
<div id="lb" role="dialog" aria-modal="true" aria-label="Item photo">
  <button id="lbx" type="button" aria-label="Close">×</button>
  <img id="lbimg" alt="">
  <div id="lbcap"></div>
</div>
<p class="foot">Quantities above ${escHtml(String(threshold))} are shown as “Available”.<br>Works offline — save this file and open it any time.</p>
<script>${pageScript(rows, brands, cats, RENDER_CAP, images)}
</script>
</body>
</html>`;

  return {
    html,
    filename: `Stock ${date}.html`,
    date,
    threshold,
    counts: { ...tree.counts, rows: rows.length },
    images: images.length,
    includeImages: Boolean(includeImages),
    brands,
    categories: cats,
    excluded: tree.excluded,
  };
}

module.exports = {
  DEFAULT_THRESHOLD,
  RENDER_CAP,
  SIZED_CATEGORIES,
  SIZE_RANK,
  FREE_SIZE,
  embedJson,
  escHtml,
  parseSizeFromName,
  itemSize,
  compareSizes,
  sizeGroups,
  makeImageIndex,
  buildRows,
  generate,
};
