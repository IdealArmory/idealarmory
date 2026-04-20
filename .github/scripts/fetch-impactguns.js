// fetch-impactguns.js
// Scrapes Impact Guns (impactguns.com) product catalog from category listing pages.
// No external dependencies — uses built-in fetch (Node 18+).
// Writes data/impactguns-{category}.json + data/impactguns-last-run.json
//
// Site: BigCommerce — product IDs in cart links, prices in listing HTML
// Affiliate: #a_aid=IdealArmory&a_cid=71c03b38 appended to every product URL
//
// Category pages paginate via ?page=N (BigCommerce standard)
// Product card HTML (simplified):
//   <li>
//     <a href="/category/product-name-UPC-SKU"><img src="..." alt="Name"></a>
//     <h4><a href="/category/product-name-UPC-SKU">Full Product Name</a></h4>
//     <p>$799.99 $719.99</p>
//     <p>In Stock</p>
//     <a href="/cart.php?action=add&product_id=125988">Add to Cart</a>
//   </li>

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL      = 'https://www.impactguns.com';
const AFF_HASH      = '#a_aid=IdealArmory&a_cid=71c03b38';
const PAGE_DELAY_MS = 3000;    // polite delay between requests (ms)
const FETCH_TIMEOUT = 35000;   // 35s per request
const MAX_PAGES     = 60;      // max pages per category slug
const MAX_RETRIES   = 3;
const USER_AGENT    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Category map: Impact Guns slug → our category ─────────────────────────────
// Top-level categories include all sub-category products on BigCommerce
const CATEGORIES = [
  { slug: 'handguns',      ourCat: 'handguns'   },
  { slug: 'rifles',        ourCat: 'rifles'     },
  { slug: 'shotguns',      ourCat: 'shotguns'   },
  { slug: 'ammo',          ourCat: 'ammunition' },
  { slug: 'optics-sights', ourCat: 'optics'     },
  { slug: 'holsters',      ourCat: 'holsters'   },
  { slug: 'magazines',     ourCat: 'magazines'  },
  { slug: 'gun-cleaning',  ourCat: 'cleaning'   },
  { slug: 'safes-storage', ourCat: 'gun-safes'  },
];

// ── Per-category product caps (sorted by price desc) ─────────────────────────
const CAT_CAPS = {
  'handguns':   600,
  'rifles':     600,
  'shotguns':   300,
  'ammunition': 800,
  'optics':     500,
  'holsters':   300,
  'magazines':  300,
  'cleaning':   150,
  'gun-safes':  200,
};

// ── Price floors per category ─────────────────────────────────────────────────
const PRICE_FLOORS = {
  'handguns':   150,
  'rifles':     250,
  'shotguns':   150,
  'ammunition':   5,
  'optics':      30,
  'holsters':    15,
  'magazines':    8,
  'cleaning':     5,
  'gun-safes':   80,
};

// ── Items to skip (accessories, apparel, misc) ────────────────────────────────
const NAME_EXCLUDE = [
  'shirt','pants','hat','cap','glove','boot','shoe','sock','apparel',
  'backpack','vest','hoodie','fleece','jacket','lanyard','patch',
  'sticker','flag','poster','book','dvd','video','manual',
];

// ── Brand extraction ──────────────────────────────────────────────────────────
// Impact Guns product names start with brand name (e.g. "Glock 17 Gen5 ...")
const KNOWN_BRANDS = [
  'Aimpoint','Aero Precision','Alien Gear','Ballistol','BCM','Benelli','Bergara',
  'Beretta','Blackhawk','Blazer','Break-Free','Browning','Bulldog','Burris',
  'Caldwell','Cannon','CCI','CMMG','Colt','CrossBreed','CZ','Daniel Defense',
  'DeSantis','EOTech','ETS','Federal','Fiocchi','Fort Knox','Galco','Geissele',
  'Girsan','Glock','Henry','Heritage','Holosun','Hornady','H&K','Heckler',
  'IWI','Kimber','LaRue','Leupold','Liberty','Magpul','Marlin','Maserin',
  'Mossberg','Nightforce','Otis','PMC','Primary Arms','ProMag','PSA','Radical',
  'Radian','Real Avid','Remington','Rossi','Ruger','Safariland','Savage',
  'Sig Sauer','SIG','Smith & Wesson','Speer','Springfield','Stack-On','Steyr',
  'Stoeger','Streamlight','Taurus','Tikka','Trijicon','Uberti','Vaultek',
  'Vedder','Vortex','Walther','Winchester','Zastava',
];

function extractBrand(name) {
  if (!name) return '';
  const n = name.trim();
  // Try multi-word brands first (longest match)
  const sorted = [...KNOWN_BRANDS].sort((a, b) => b.length - a.length);
  for (const b of sorted) {
    if (n.toLowerCase().startsWith(b.toLowerCase())) return b;
  }
  // Fall back to first word
  return n.split(/[\s,]/)[0] || '';
}

// ── UPC / SKU extraction from URL slug ────────────────────────────────────────
// URL pattern: /category/product-name-UPCSEGMENT-SKU
// UPC is a 12–13 digit number embedded in the slug
function extractUpcSku(productUrl) {
  const slug = productUrl.split('/').filter(Boolean).pop() || '';
  const parts = slug.split('-');
  let upc = '', sku = '';
  // Work backward — last numeric segment is SKU, 12-13 digit segment before is UPC
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d{12,13}$/.test(parts[i])) {
      upc = parts[i];
      sku = parts.slice(i + 1).join('-');
      break;
    }
  }
  if (!sku && /^\d+$/.test(parts[parts.length - 1])) {
    sku = parts[parts.length - 1];
  }
  return { upc, sku };
}

// ── HTML entity decoder ───────────────────────────────────────────────────────
function decodeHtml(str) {
  return (str || '')
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#x27;/g,  "'")
    .replace(/&#x2F;/g,  '/');
}

// ── Affiliate URL builder ─────────────────────────────────────────────────────
function addAffiliate(url) {
  if (!url) return '';
  // Strip any existing fragment, add ours
  const base = url.split('#')[0];
  return base + AFF_HASH;
}

// ── Parse a single listing page into raw product records ─────────────────────
// Returns array of { productId, productUrl, name, img, price, msrp, inStock }
//
// BigCommerce product pages expose product IDs in multiple places:
//   1. Cart links:   href="/cart.php?action=add&product_id=12345"
//   2. Image paths:  cdn*.bigcommerce.com/.../products/12345/...
//   3. Data attrs:   data-product-id="12345"  (Stencil theme standard)
// We collect from all three sources then deduplicate by product ID.
function parseListingPage(html) {
  const seen     = new Set();
  const products = [];

  // ── Method A: BigCommerce CDN image URLs ────────────────────────────────────
  // Image src embeds product ID: .../products/12345/variant_id/filename
  // This is the most reliable anchor — always present, never encoded
  const imgRe = /src="(https:\/\/cdn\d+\.bigcommerce\.com\/s-[^/]+\/images\/[^/]+\/products\/(\d+)\/[^"]+)"/g;
  let im;
  while ((im = imgRe.exec(html)) !== null) {
    const imgUrl    = im[1].split('?')[0];
    const productId = im[2];
    if (seen.has(productId)) continue;

    const pos = im.index;
    // Window: 500 chars before image (for the wrapping <a> link) and 4000 after (for name, price, stock, cart)
    const winStart = Math.max(0, pos - 500);
    const winEnd   = Math.min(html.length, pos + 4000);
    const win      = html.slice(winStart, winEnd);

    // ── Product URL ───────────────────────────────────────────────────────────
    // Find all internal product links (not cart/account/utility pages)
    const urlRe  = /href="((?:https:\/\/www\.impactguns\.com)?\/(?!cart|account|login|checkout|compare|brands|sitemap|wishlist|blog|contact|about|search|wishlist)[a-z0-9][a-z0-9-]+\/[a-z0-9][a-z0-9-]{5,})"/g;
    let um, lastUrl = null;
    while ((um = urlRe.exec(win)) !== null) lastUrl = um[1];
    if (!lastUrl) continue;
    const productUrl = lastUrl.startsWith('http') ? lastUrl : BASE_URL + lastUrl;

    // ── Product name ──────────────────────────────────────────────────────────
    // Try last <h2>/<h3>/<h4> with an anchor inside, fall back to <img alt>
    const hRe = /<h[2-5][^>]*>\s*<a[^>]*>([^<]{8,})<\/a>\s*<\/h[2-5]>/gi;
    let hm, lastH = null;
    while ((hm = hRe.exec(win)) !== null) lastH = hm;
    let name = lastH ? decodeHtml(lastH[1].trim()) : '';

    if (!name) {
      // alt text on this specific image
      const altM = im[1] ? win.match(/alt="([^"]{8,})"/) : null;
      name = altM ? decodeHtml(altM[1].trim()) : '';
    }
    if (!name || name.length < 6) continue;

    // ── Prices ────────────────────────────────────────────────────────────────
    // Grab $ amounts in a 2000-char window around the image; last 1–4 are relevant
    const pWin = html.slice(Math.max(0, pos - 200), Math.min(html.length, pos + 2000));
    const pRe  = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;
    const vals = [];
    let pm;
    while ((pm = pRe.exec(pWin)) !== null) {
      const v = parseFloat(pm[1].replace(/,/g, ''));
      if (v > 0.5 && v < 50000) vals.push(v);
    }
    const recent = vals.slice(-4);
    const price  = recent.length ? Math.min(...recent) : 0;
    const msrp   = recent.length > 1 ? Math.max(...recent) : price;
    if (price <= 0) continue;

    // ── Stock status ──────────────────────────────────────────────────────────
    const sWin    = html.slice(Math.max(0, pos - 200), Math.min(html.length, pos + 2000));
    const inStock = /in[\s-]?stock/i.test(sWin) &&
                    !/out[\s-]?of[\s-]?stock/i.test(sWin) &&
                    !/pre[\s-]?order/i.test(sWin);

    seen.add(productId);
    products.push({ productId, productUrl, name, img: imgUrl, price, msrp, inStock });
  }

  // ── Method B: Cart links (fallback for any missed by image method) ──────────
  const cartRe = /href="[^"]*cart\.php\?action=add&(?:amp;)?product_id=(\d+)"/g;
  let cm;
  while ((cm = cartRe.exec(html)) !== null) {
    const productId = cm[1];
    if (seen.has(productId)) continue;   // already captured above

    const pos      = cm.index;
    const winStart = Math.max(0, pos - 3000);
    const win      = html.slice(winStart, pos + 200);

    const urlRe  = /href="((?:https:\/\/www\.impactguns\.com)?\/(?!cart|account|login|checkout|compare|brands|sitemap|wishlist|blog|contact|about|search)[a-z0-9][a-z0-9-]+\/[a-z0-9][a-z0-9-]{5,})"/g;
    let um, lastUrl = null;
    while ((um = urlRe.exec(win)) !== null) lastUrl = um[1];
    if (!lastUrl) continue;
    const productUrl = lastUrl.startsWith('http') ? lastUrl : BASE_URL + lastUrl;

    const hRe = /<h[2-5][^>]*>\s*<a[^>]*>([^<]{8,})<\/a>\s*<\/h[2-5]>/gi;
    let hm, lastH = null;
    while ((hm = hRe.exec(win)) !== null) lastH = hm;
    const name = lastH ? decodeHtml(lastH[1].trim()) : '';
    if (!name) continue;

    const imgM = win.match(/src="(https:\/\/cdn\d+\.bigcommerce\.com\/[^"]+\.(?:jpg|jpeg|png|webp))"/i);
    const img  = imgM ? imgM[1].split('?')[0] : '';

    const pRe = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;
    const vals = [];
    let pm;
    while ((pm = pRe.exec(win)) !== null) {
      const v = parseFloat(pm[1].replace(/,/g, ''));
      if (v > 0.5 && v < 50000) vals.push(v);
    }
    const recent = vals.slice(-4);
    const price  = recent.length ? Math.min(...recent) : 0;
    const msrp   = recent.length > 1 ? Math.max(...recent) : price;
    if (price <= 0) continue;

    const inStock = /in[\s-]?stock/i.test(win) && !/out[\s-]?of[\s-]?stock/i.test(win);

    seen.add(productId);
    products.push({ productId, productUrl, name, img, price, msrp, inStock });
  }

  return products;
}

// ── Check if more pages exist ─────────────────────────────────────────────────
function hasNextPage(html, currentPage) {
  // BigCommerce shows page links; look for a link to page N+1
  const next = currentPage + 1;
  return html.includes(`page=${next}`) || html.includes(`>Next<`) || html.includes(`>Next &`) ;
}

// ── Fetch with retry ──────────────────────────────────────────────────────────
async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      const wait = attempt * 5000;
      console.warn(`  Retry ${attempt}/${retries} for ${url}: ${err.message} — waiting ${wait/1000}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// ── Delay helper ─────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Scrape one category (all pages) ──────────────────────────────────────────
async function scrapeCategory(slug, ourCat, seenIds) {
  console.log(`\n  [${ourCat}] Scraping /${slug} ...`);
  const products = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const url = page === 1
      ? `${BASE_URL}/${slug}/`
      : `${BASE_URL}/${slug}/?page=${page}`;

    let html;
    try {
      html = await fetchWithRetry(url);
    } catch (err) {
      console.warn(`  /${slug}?page=${page} failed: ${err.message} — stopping this category`);
      break;
    }

    // Parse products from this page
    const pageProducts = parseListingPage(html);

    if (pageProducts.length === 0) {
      console.log(`  /${slug} page ${page}: 0 products — end of category`);
      break;
    }

    let newCount = 0;
    for (const p of pageProducts) {
      if (seenIds.has(p.productId)) continue;  // global dedup across categories
      seenIds.add(p.productId);
      products.push(p);
      newCount++;
    }

    console.log(`  /${slug} page ${page}: ${pageProducts.length} parsed, ${newCount} new (total: ${products.length})`);

    if (!hasNextPage(html, page)) {
      console.log(`  /${slug}: no more pages after page ${page}`);
      break;
    }

    page++;
    await sleep(PAGE_DELAY_MS);
  }

  return products;
}

// ── Transform raw record to our product schema ────────────────────────────────
function transformProduct(raw, ourCat) {
  const { upc, sku } = extractUpcSku(raw.productUrl);
  const brand = extractBrand(raw.name);

  return {
    id:       'ig_' + raw.productId,
    brand,
    name:     raw.name,
    price:    raw.price,
    orig:     raw.msrp,
    img:      raw.img,
    url:      addAffiliate(raw.productUrl),
    category: ourCat,
    upc,
    sku,
    inStock:  raw.inStock,
    src:      'impactguns',
  };
}

// ── Relevance filter ──────────────────────────────────────────────────────────
function isRelevant(raw, ourCat) {
  if (!raw.img)            return false;   // must have image
  if (raw.price <= 0)      return false;   // must have price
  if (!raw.inStock)        return false;   // in-stock only

  const floor = PRICE_FLOORS[ourCat] || 0;
  if (raw.price < floor)   return false;

  const n = raw.name.toLowerCase();
  if (NAME_EXCLUDE.some(kw => n.includes(kw))) return false;

  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Impact Guns Catalog Fetch ===');
  console.log(`Base URL : ${BASE_URL}`);
  console.log(`Started  : ${new Date().toISOString()}\n`);

  const seenIds   = new Set();   // global dedup across all categories
  const allByCategory = {};      // ourCat → products[]
  let totalRaw = 0;

  for (const { slug, ourCat } of CATEGORIES) {
    const raw = await scrapeCategory(slug, ourCat, seenIds);
    totalRaw += raw.length;

    const relevant = raw.filter(r => isRelevant(r, ourCat)).map(r => transformProduct(r, ourCat));
    console.log(`  /${slug}: ${raw.length} scraped → ${relevant.length} relevant`);

    if (!allByCategory[ourCat]) allByCategory[ourCat] = [];
    allByCategory[ourCat].push(...relevant);
  }

  // ── Quality gate ──────────────────────────────────────────────────────────
  const totalRelevant = Object.values(allByCategory).reduce((s, a) => s + a.length, 0);
  console.log(`\nTotal scraped : ${totalRaw}`);
  console.log(`Total relevant: ${totalRelevant}`);

  if (totalRelevant < 100) {
    console.error(`QUALITY GATE FAILED: Only ${totalRelevant} relevant products — possible scrape failure or site structure change.`);
    process.exit(1);
  }

  // ── Write output files ────────────────────────────────────────────────────
  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const catCounts  = {};
  const filesWritten = [];

  for (const [cat, products] of Object.entries(allByCategory)) {
    if (products.length === 0) continue;

    // Sort by price descending, apply cap
    products.sort((a, b) => b.price - a.price);
    const cap   = CAT_CAPS[cat];
    const final = cap && products.length > cap ? products.slice(0, cap) : products;
    if (cap && products.length > cap) {
      console.log(`  [cap] ${cat}: ${products.length} → ${cap}`);
    }

    catCounts[cat] = final.length;
    const fname = `impactguns-${cat}.json`;
    fs.writeFileSync(path.join(dataDir, fname), JSON.stringify(final));
    const kb = Math.round(fs.statSync(path.join(dataDir, fname)).size / 1024);
    console.log(`  Wrote ${fname}: ${final.length} products (${kb} KB)`);
    filesWritten.push(fname);
  }

  // Write last-run metadata
  fs.writeFileSync(
    path.join(dataDir, 'impactguns-last-run.json'),
    JSON.stringify({
      lastRun:      new Date().toISOString(),
      productCount: totalRelevant,
      rawCount:     totalRaw,
      categories:   catCounts,
      files:        filesWritten,
      status:       'success',
    }, null, 2)
  );

  console.log(`\n========================================`);
  console.log(` SUCCESS`);
  console.log(` ${totalRelevant} products across ${filesWritten.length} categories`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
