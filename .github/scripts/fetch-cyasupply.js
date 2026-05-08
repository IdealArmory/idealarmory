// fetch-cyasupply.js
// Fetches the CYA Supply Co. product catalog via Shopify's public /products.json API.
// No scraping needed — Shopify exposes full product data (price, images, availability)
// without authentication.
//
// Affiliate: ?bg_ref=6mIW8B3buQ appended to every product URL (Bixgrow)
// Output:    data/cyasupply-holsters.json  (+ other categories as catalog expands)

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL    = 'https://www.cyasupply.com';
const AFF_PARAM   = '?bg_ref=6mIW8B3buQ';
const PAGE_LIMIT  = 250;      // Shopify max per page
const FETCH_TIMEOUT = 20000;
const PAGE_DELAY_MS = 1000;   // polite delay between pages
const USER_AGENT  = 'Mozilla/5.0 (compatible; IdealArmory/1.0; +https://idealarmory.com)';

// Category detection keywords (checked against title + product_type + tags)
const CAT_RULES = [
  { cat: 'holsters',  keys: ['holster','iwb','owb','appendix','shoulder holster','ankle holster','chest holster','paddle','belt slide'] },
  { cat: 'cleaning',  keys: ['cleaning kit','clean kit','solvent','lubricant','bore','patch'] },
  { cat: 'magazines', keys: ['magazine','mag ','mags'] },
  { cat: 'holsters',  keys: ['belt','mag carrier','magazine carrier','speed loader'] }, // related accessories → holsters page
];

function detectCategory(product) {
  const haystack = [
    product.title,
    product.product_type,
    ...(product.tags || []),
  ].join(' ').toLowerCase();

  for (const rule of CAT_RULES) {
    if (rule.keys.some(k => haystack.includes(k))) return rule.cat;
  }
  // CYA is primarily a holster brand — default everything else to holsters
  return 'holsters';
}

function affiliateUrl(handle) {
  return `${BASE_URL}/products/${handle}${AFF_PARAM}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Transform a Shopify product → our schema ──────────────────────────────────
function transformProduct(sp, category) {
  // Use the lowest price across all variants (some holsters have RH/LH/optics variants)
  const allVariants       = sp.variants || [];
  const availableVariants = allVariants.filter(v => v.available);
  const priceSource       = availableVariants.length > 0 ? availableVariants : allVariants;

  const prices     = priceSource.map(v => parseFloat(v.price || '0')).filter(p => p > 0);
  const compPrices = allVariants.map(v => parseFloat(v.compare_at_price || '0')).filter(p => p > 0);

  const price = prices.length > 0 ? Math.min(...prices) : 0;
  const orig  = compPrices.length > 0 ? Math.max(...compPrices) : price;

  const img    = (sp.images && sp.images[0]) ? sp.images[0].src : '';
  const inStock = allVariants.some(v => v.available);

  return {
    id:       'cya_' + sp.id,
    brand:    sp.vendor || 'CYA Supply Co.',
    name:     sp.title,
    price:    price,
    orig:     orig || price,
    img:      img,
    url:      affiliateUrl(sp.handle),
    category: category,
    upc:      '',     // Shopify doesn't expose UPC via public API
    inStock:  inStock,
    src:      'cyasupply',
  };
}

// ── Fetch all pages ───────────────────────────────────────────────────────────
async function fetchAllProducts() {
  const products = [];
  let page = 1;

  while (true) {
    const url = `${BASE_URL}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
    console.log(`  Page ${page}: ${url}`);

    let data;
    try {
      data = await fetchJson(url);
    } catch (err) {
      console.warn(`  Page ${page} failed: ${err.message}`);
      break;
    }

    const items = data.products || [];
    console.log(`  Page ${page}: ${items.length} products`);

    if (items.length === 0) break;
    products.push(...items);

    if (items.length < PAGE_LIMIT) break; // last page
    page++;
    await sleep(PAGE_DELAY_MS);
  }

  return products;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== CYA Supply Co. Catalog Fetch ===');
  console.log(`Started: ${new Date().toISOString()}\n`);

  const raw = await fetchAllProducts();
  console.log(`\nTotal raw products: ${raw.length}`);

  if (raw.length === 0) {
    console.error('QUALITY GATE: 0 products returned — likely a fetch failure.');
    process.exit(1);
  }

  // Group by category
  const byCategory = {};
  let skipped = 0;

  for (const sp of raw) {
    // Skip products with no price
    const prices = (sp.variants || []).map(v => parseFloat(v.price || '0')).filter(p => p > 0);
    if (prices.length === 0) { skipped++; continue; }

    const category = detectCategory(sp);
    const product  = transformProduct(sp, category);
    if (!product.price || product.price <= 0) { skipped++; continue; }

    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push(product);
  }

  console.log(`\nSkipped (no price): ${skipped}`);
  console.log('Category breakdown:');
  for (const [cat, prods] of Object.entries(byCategory)) {
    console.log(`  ${cat}: ${prods.length}`);
  }

  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const filesWritten = [];
  let totalWritten   = 0;

  for (const [cat, products] of Object.entries(byCategory)) {
    // Sort in-stock first, then by price ascending
    products.sort((a, b) => {
      if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
      return a.price - b.price;
    });

    const fname = `cyasupply-${cat}.json`;
    const fpath = path.join(dataDir, fname);
    fs.writeFileSync(fpath, JSON.stringify(products));
    const kb = Math.round(fs.statSync(fpath).size / 1024);
    console.log(`  Wrote ${fname}: ${products.length} products (${kb} KB)`);
    filesWritten.push(fname);
    totalWritten += products.length;
  }

  // Last-run metadata
  fs.writeFileSync(
    path.join(dataDir, 'cyasupply-last-run.json'),
    JSON.stringify({
      lastRun:      new Date().toISOString(),
      rawCount:     raw.length,
      totalWritten: totalWritten,
      categories:   Object.fromEntries(Object.entries(byCategory).map(([c,p]) => [c, p.length])),
      files:        filesWritten,
      status:       'success',
    }, null, 2)
  );

  console.log(`\n========================================`);
  console.log(` SUCCESS — ${totalWritten} products across ${filesWritten.length} file(s)`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
