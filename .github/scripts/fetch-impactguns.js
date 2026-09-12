// fetch-impactguns.js
// Scrapes Impact Guns (impactguns.com) product catalog.
// Phase 1: parse category listing pages — extracts price + stock from HTML directly.
// Phase 2: BigCommerce JSON API enrichment ONLY for products where HTML price parsing
//          returned 0 (i.e. the price wasn't found in the listing page HTML).
//          Phase 2 failures are non-fatal — products with listing-page prices still ship.
// Phase 3: Filter, group by category, write JSON files.
//
// Affiliate: #a_aid=IdealArmory&a_cid=71c03b38 appended to every product URL
// Price API: GET /remote/v1/product-attributes/{productId}

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL       = 'https://www.impactguns.com';
const AFF_HASH       = '#a_aid=IdealArmory&a_cid=71c03b38';
const PAGE_DELAY_MS  = 2500;   // delay between listing page fetches
const API_DELAY_MS   = 500;    // delay between price API calls (reduced from 800ms)
const FETCH_TIMEOUT  = 35000;
const MAX_PAGES      = 80;
const MAX_RETRIES    = 3;
const USER_AGENT     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Category map ──────────────────────────────────────────────────────────────
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

// ── Per-category product caps ─────────────────────────────────────────────────
const CAT_CAPS = {
  'handguns':   900, 'rifles': 1300, 'shotguns': 450,
  'ammunition': 800, 'optics': 500,  'holsters': 300,
  'magazines':  300, 'cleaning': 150, 'gun-safes': 200,
};

// Phase 1 stops collecting once this multiple of the cap is reached.
// Raised to 1.6 so the priority-brand sort has a large pool to draw from.
const CAP_COLLECT_MULTIPLIER = 1.6;

// ── Priority brands per category ──────────────────────────────────────────────
// These brands are surfaced first (before cap) so popular hunting/sporting
// manufacturers don't get pushed out by Impact Guns' "featured" listing order.
const PRIORITY_BRANDS = {
  rifles: ['ruger','tikka','weatherby','cva','browning','remington','winchester',
           'bergara','cz','savage','mossberg','henry','howa','rossi','traditions',
           'christensen','fn america','sig sauer','springfield','daniel defense',
           'barrett','lwrc','steyr','kel-tec'],
  handguns: ['glock','sig sauer','smith & wesson','ruger','springfield','taurus',
             'beretta','canik','walther','cz'],
  shotguns: ['mossberg','remington','winchester','benelli','beretta','browning','savage']
};

// ── Price floors ──────────────────────────────────────────────────────────────
const PRICE_FLOORS = {
  'handguns': 300, 'rifles': 300, 'shotguns': 300,
  'ammunition': 5, 'optics': 30,  'holsters': 15,
  'magazines': 8,  'cleaning': 5, 'gun-safes': 80,
};

// ── Name exclusions ───────────────────────────────────────────────────────────
const NAME_EXCLUDE = [
  'shirt','pants','hat ','cap ','glove','boot','shoe','sock','apparel',
  'backpack','vest ','hoodie','fleece','jacket','lanyard','patch',
  'sticker','flag','poster','book','dvd','video',
];

// ── Known brands for extraction ───────────────────────────────────────────────
const KNOWN_BRANDS = [
  'Aimpoint','Aero Precision','Alien Gear','Ballistol','BCM','Benelli','Bergara',
  'Beretta','Blackhawk','Blazer','Break-Free','Browning','Bulldog','Burris',
  'Caldwell','Cannon','CCI','CMMG','Colt','CrossBreed','CZ','Daniel Defense',
  'DeSantis','EOTech','ETS','Federal','Fiocchi','Fort Knox','Galco','Geissele',
  'Girsan','Glock','Henry','Heritage','Holosun','Hornady','H&K','Heckler',
  'IWI','Kimber','LaRue','Leupold','Liberty','Magpul','Marlin',
  'Mossberg','Nightforce','Otis','PMC','Primary Arms','ProMag','PSA',
  'Radian','Real Avid','Remington','Rossi','Ruger','Safariland','Savage',
  'Sig Sauer','SIG','Smith & Wesson','Speer','Springfield','Stack-On','Steyr',
  'Stoeger','Streamlight','Taurus','Tikka','Trijicon','Uberti','Vaultek',
  'Vedder','Vortex','Walther','Winchester','Zastava',
];

function extractBrand(name) {
  if (!name) return '';
  const n = name.trim();
  const sorted = [...KNOWN_BRANDS].sort((a, b) => b.length - a.length);
  for (const b of sorted) {
    if (n.toLowerCase().startsWith(b.toLowerCase())) return b;
  }
  return n.split(/[\s,]/)[0] || '';
}

// ── UPC / SKU from URL slug ───────────────────────────────────────────────────
function extractUpcSku(productUrl) {
  const slug  = (productUrl.split('/').filter(Boolean).pop() || '').split('#')[0];
  const parts = slug.split('-');
  let upc = '', sku = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d{12,13}$/.test(parts[i])) {
      upc = parts[i];
      sku = parts.slice(i + 1).join('-');
      break;
    }
  }
  if (!sku && /^\d{3,8}$/.test(parts[parts.length - 1])) {
    sku = parts[parts.length - 1];
  }
  return { upc, sku };
}

function decodeHtml(str) {
  return (str || '')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/&#x27;/g,"'").replace(/&#x2F;/g,'/');
}

function addAffiliate(url) {
  return url ? url.split('#')[0] + AFF_HASH : '';
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      const wait = attempt * 5000;
      console.warn(`  Retry ${attempt}/${retries} for ${url}: ${err.message} — wait ${wait/1000}s`);
      await sleep(wait);
    }
  }
}

async function fetchJson(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'X-Requested-With': 'XMLHttpRequest',
                 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── Parse price from listing-page card HTML ───────────────────────────────────
// BigCommerce Stencil themes embed prices in the listing HTML directly.
// Try multiple patterns in order of specificity.
function parsePriceFromHtml(cardHtml) {
  // 1. data attribute (most reliable, set by Stencil theme)
  const patterns = [
    /data-product-price-without-tax[^>]*>\s*\$?([\d,]+\.?\d{0,2})/i,
    /data-product-price="([\d.]+)"/i,
    /<span[^>]+data-product-price[^>]*>\s*\$?([\d,]+\.?\d{0,2})/i,
    /class="[^"]*price--withoutTax[^"]*"[^>]*>\s*\$?([\d,]+\.?\d{0,2})/i,
    /class="[^"]*price price--main[^"]*"[^>]*>[\s\S]{0,300}\$?([\d,]+\.\d{2})/i,
    /itemprop="price"[^>]*content="([\d.]+)"/i,
    /"price_without_tax"\s*:\s*\{"value"\s*:\s*([\d.]+)/i,
    /"price"\s*:\s*([\d.]+)\s*,\s*"formatted"/i,
  ];
  for (const re of patterns) {
    const m = cardHtml.match(re);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val > 0) return val;
    }
  }
  return 0;
}

// ── Parse in-stock status from listing-page card HTML ─────────────────────────
function parseStockFromHtml(cardHtml) {
  // Out-of-stock signals (checked first — more definitive)
  if (/sold[\s-]?out|out[\s-]of[\s-]stock|notify[\s-]me|pre[\s-]?order/i.test(cardHtml)) {
    return false;
  }
  // In-stock signals
  if (/data-button-type="add-cart"|class="[^"]*button--addCart[^"]*"|addToCart|add.to.cart/i.test(cardHtml)) {
    return true;
  }
  // Default optimistic — API will correct if enrichment runs
  return true;
}

// ── Parse listing page → raw product stubs ────────────────────────────────────
// Extracts product ID, URL, name, image, price, and in-stock from the HTML.
// Products where price=0 are candidates for Phase 2 API enrichment.
function parseListingPage(html) {
  const seen     = new Set();
  const products = [];

  // BigCommerce CDN images embed product ID: .../products/{ID}/...
  const imgRe = /src="(https?:\/\/cdn\d+\.bigcommerce\.com\/[^"]*\/products\/(\d+)\/[^"]+)"/g;
  let im;

  while ((im = imgRe.exec(html)) !== null) {
    const imgUrl    = im[1].split('?')[0];
    const productId = im[2];
    if (seen.has(productId)) continue;

    const pos = im.index;

    // Product URL — the <a> that wraps this image is BEFORE it in the HTML
    const preWin = html.slice(Math.max(0, pos - 1200), pos);
    const urlRe  = /href="((?:https?:\/\/www\.impactguns\.com)?\/(?!cart|account|login|checkout|compare|brands|sitemap|wishlist|blog|contact|about|search|gift|rss|subscribe)[a-z0-9][a-z0-9-]+\/[a-z0-9][a-z0-9-]{3,}[^"#?]*)"/g;
    let um, lastUrl = null;
    while ((um = urlRe.exec(preWin)) !== null) lastUrl = um[1];
    if (!lastUrl) continue;
    const productUrl = lastUrl.startsWith('http') ? lastUrl : BASE_URL + lastUrl;

    // Product card HTML window — use 8000 chars after image (price is below name)
    const cardHtml = html.slice(pos, Math.min(html.length, pos + 8000));

    // Product name — heading link comes AFTER the image in BigCommerce card layout
    const hRe = /<h[2-5][^>]*>\s*<a[^>]*>([^<]{6,})<\/a>/gi;
    let hm, firstH = null;
    while ((hm = hRe.exec(cardHtml)) !== null) { firstH = hm; break; }
    let name = firstH ? decodeHtml(firstH[1].trim()) : '';

    // Fallback: aria-label or title attribute on a nearby link
    if (!name) {
      const ariaM = cardHtml.match(/aria-label="([^"]{8,})"/);
      name = ariaM ? decodeHtml(ariaM[1].trim()) : '';
    }
    // Fallback: alt text on this image
    if (!name) {
      const altM = im[0].match(/alt="([^"]{8,})"/);
      name = altM ? decodeHtml(altM[1].trim()) : '';
    }
    if (!name || name.length < 6) continue;

    // Price and stock from listing HTML (Phase 1 primary source)
    const listPrice = parsePriceFromHtml(cardHtml);
    const inStock   = parseStockFromHtml(cardHtml);

    seen.add(productId);
    products.push({
      productId, productUrl, name, img: imgUrl,
      price:   listPrice,
      msrp:    0,          // MSRP enriched by API if available
      inStock: inStock,
      htmlPriceFound: listPrice > 0,  // flag: skip API if true
    });
  }

  return products;
}

// ── Detect pagination ─────────────────────────────────────────────────────────
function hasNextPage(html, currentPage) {
  const next = currentPage + 1;
  return html.includes(`page=${next}`)
    || html.includes(`pagination-item--next`)
    || /aria-label="[Nn]ext/.test(html)
    || html.includes('>Next<')
    || html.includes('>Next ');
}

// ── Phase 2: Enrich via BigCommerce JSON API (only for price=0 products) ──────
// Non-fatal: if the API is blocked or rate-limited, we proceed with listing prices.
async function enrichWithApi(products) {
  const toEnrich = products.filter(p => !p.htmlPriceFound);

  if (toEnrich.length === 0) {
    console.log('  API: all prices parsed from listing HTML — skipping Phase 2');
    return;
  }

  console.log(`  API: ${toEnrich.length}/${products.length} products need price enrichment`);
  const API_BATCH = 20;
  let enriched = 0, failed = 0, consecutiveFails = 0;
  const CONSECUTIVE_FAIL_LIMIT = 30; // give up if 30 consecutive API calls fail

  for (let i = 0; i < toEnrich.length; i++) {
    if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
      console.warn(`  API: ${CONSECUTIVE_FAIL_LIMIT} consecutive failures — API likely blocked, stopping enrichment`);
      break;
    }

    const p   = toEnrich[i];
    const url = `${BASE_URL}/remote/v1/product-attributes/${p.productId}`;
    const data = await fetchJson(url);

    if (data && data.data) {
      const d = data.data;
      const priceObj = d.price || {};
      const saleP  = priceObj.sale_price_without_tax  || priceObj.sale_price_with_tax;
      const baseP  = priceObj.price_without_tax        || priceObj.price_with_tax
                  || priceObj.without_tax               || priceObj.with_tax;
      const rrp    = priceObj.rrp_without_tax           || priceObj.rrp_with_tax;

      const saleVal = saleP  ? (saleP.value  || parseFloat(saleP.formatted  || '0')) : 0;
      const baseVal = baseP  ? (baseP.value  || parseFloat(baseP.formatted  || '0')) : 0;
      const rrpVal  = rrp    ? (rrp.value    || parseFloat(rrp.formatted    || '0')) : 0;

      p.price   = saleVal || baseVal || 0;
      p.msrp    = rrpVal  || baseVal || p.price;
      p.inStock = !!(d.instock);

      if (d.sku) p.apiSku = d.sku;
      if (d.upc) p.apiUpc = d.upc;

      enriched++;
      consecutiveFails = 0;
    } else {
      failed++;
      consecutiveFails++;
    }

    if ((i + 1) % API_BATCH === 0 || i === toEnrich.length - 1) {
      process.stdout.write(`    API: ${i+1}/${toEnrich.length} (ok:${enriched} fail:${failed})\r`);
    }
    await sleep(API_DELAY_MS);
  }
  console.log(`\n  API done: ${enriched} enriched, ${failed} failed`);
}

// ── Scrape one category (all pages, stops at collect cap) ─────────────────────
async function scrapeCategory(slug, ourCat, seenIds) {
  console.log(`\n  [${ourCat}] /${slug}`);
  const cap        = CAT_CAPS[ourCat] || 500;
  const collectCap = Math.ceil(cap * CAP_COLLECT_MULTIPLIER);
  const products   = [];
  let page         = 1;

  while (page <= MAX_PAGES) {
    const url = page === 1
      ? `${BASE_URL}/${slug}/`
      : `${BASE_URL}/${slug}/?page=${page}`;

    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`    Page ${page} fetch failed: ${err.message}`);
      break;
    }

    // Pagination debug on page 1
    if (page === 1) {
      const pageLinks = [...new Set((html.match(/page=\d+/g) || []))].sort();
      console.log(`    Page 1: size=${html.length}, pageLinks=[${pageLinks.join(',')}], next=${hasNextPage(html,1)}`);
      const firstProd = parseListingPage(html)[0];
      if (firstProd) {
        const priceStr = firstProd.htmlPriceFound ? `$${firstProd.price.toFixed(2)}` : 'no HTML price';
        console.log(`    First product: id=${firstProd.productId} name="${firstProd.name.slice(0,55)}" price=${priceStr}`);
      } else {
        console.log(`    First product: NONE FOUND`);
        const cdnIdx = html.indexOf('bigcommerce.com');
        if (cdnIdx >= 0) console.log(`    CDN snippet: ${html.slice(cdnIdx, cdnIdx+200).replace(/\n/g,' ')}`);
      }
    }

    const pageProducts = parseListingPage(html);
    if (pageProducts.length === 0) {
      console.log(`    Page ${page}: 0 products — stopping`);
      break;
    }

    let newCount = 0;
    for (const p of pageProducts) {
      if (seenIds.has(p.productId)) continue;
      seenIds.add(p.productId);
      products.push(p);
      newCount++;
    }

    const htmlPriced = products.filter(p => p.htmlPriceFound).length;
    console.log(`    Page ${page}: ${pageProducts.length} parsed, ${newCount} new (total: ${products.length}, html-priced: ${htmlPriced})`);

    // Stop early once we have enough products for this category
    if (products.length >= collectCap) {
      console.log(`    Collect cap reached (${products.length}/${collectCap}) — stopping Phase 1 for ${ourCat}`);
      break;
    }

    if (!hasNextPage(html, page)) break;
    page++;
    await sleep(PAGE_DELAY_MS);
  }

  return products;
}

// ── Transform to our product schema ──────────────────────────────────────────
function transformProduct(raw, ourCat) {
  const { upc, sku } = extractUpcSku(raw.productUrl);
  return {
    id:       'ig_' + raw.productId,
    brand:    extractBrand(raw.name),
    name:     raw.name,
    price:    raw.price,
    orig:     raw.msrp || raw.price,
    img:      raw.img,
    url:      addAffiliate(raw.productUrl),
    category: ourCat,
    upc:      raw.apiUpc  || upc,
    sku:      raw.apiSku  || sku,
    inStock:  raw.inStock,
    src:      'impactguns',
  };
}

// ── Relevance filter ──────────────────────────────────────────────────────────
function isRelevant(raw, ourCat) {
  if (!raw.img)            return false;
  if (raw.price <= 0)      return false;
  if (raw.price < (PRICE_FLOORS[ourCat] || 0)) return false;
  const n = raw.name.toLowerCase();
  if (NAME_EXCLUDE.some(kw => n.includes(kw))) return false;
  // Only filter out-of-stock when we have reliable API stock data.
  // For HTML-priced products (no API call), accept optimistically.
  if (!raw.htmlPriceFound && !raw.inStock) return false;
  return true;
}

// ── Price-banded cap sampling for firearm categories ────────────────────────────
// Plain "priority-brand first, listing order" can still let a glut of cheap
// listings dominate a category. Sampling evenly across price bands (by rank,
// not just the cheapest end) spreads the catalog across the range people shop in.
const PRICE_BANDS = {
  handguns: [[300, 450], [450, 700], [700, 1200], [1200, Infinity]],
  rifles:   [[300, 500], [500, 900], [900, 1500], [1500, Infinity]],
  shotguns: [[300, 450], [450, 700], [700, 1200], [1200, Infinity]],
};

function spreadSample(sortedList, k) {
  if (k <= 0) return [];
  const n = sortedList.length;
  if (n <= k) return sortedList.slice();
  if (k === 1) return [sortedList[0]];
  const step = (n - 1) / (k - 1);
  const seen = new Set();
  const result = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.round(i * step);
    if (seen.has(idx)) continue;
    seen.add(idx);
    result.push(sortedList[idx]);
  }
  return result;
}

function bandedCap(products, cap, bands, priorityBrands) {
  const isPriority = p => priorityBrands.some(br => (p.brand || p.name || '').toLowerCase().includes(br));
  const perBand = Math.ceil(cap / bands.length);
  let remaining = cap;
  const result = [];
  const used = new Set();

  for (const [lo, hi] of bands) {
    const bandItems = products.filter(p => p.price >= lo && p.price < hi);
    const pri  = bandItems.filter(isPriority).sort((a, b) => a.price - b.price);
    const rest = bandItems.filter(p => !isPriority(p)).sort((a, b) => a.price - b.price);
    const take = Math.min(perBand, remaining);
    const chosen = pri.length >= take ? spreadSample(pri, take) : pri.concat(spreadSample(rest, take - pri.length));
    chosen.forEach(p => used.add(p));
    result.push(...chosen);
    remaining -= chosen.length;
  }

  if (remaining > 0) {
    const unused = products.filter(p => !used.has(p)).sort((a, b) => {
      const ap = isPriority(a), bp = isPriority(b);
      if (ap !== bp) return ap ? -1 : 1;
      return a.price - b.price;
    });
    result.push(...unused.slice(0, remaining));
  }
  return result;
}

// UPCs already carried by the other three retailer feeds for this category — read
// straight from their committed data/ files. Used to guarantee genuine cross-retailer
// matches survive the cap instead of being at the mercy of price-band sampling.
function loadSiblingUpcs(dataDir, cat) {
  const upcs = new Set();
  for (const src of ['eurooptic', 'bereli', 'gunscom']) {
    try {
      const items = JSON.parse(fs.readFileSync(path.join(dataDir, `${src}-${cat}.json`), 'utf8'));
      items.forEach(p => { if (p.upc) upcs.add(p.upc); });
    } catch (e) { /* file may not exist for this retailer/category — fine */ }
  }
  return upcs;
}

// Guarantees every item whose UPC also appears at EuroOptic/Bereli/Guns.com survives
// the cap — a cross-retailer match is itself strong evidence of a genuinely popular
// product, not just an artifact of price-band sampling.
function bandedCapWithCrossMatch(products, cap, bands, priorityBrands, siblingUpcs) {
  const isCross = p => p.upc && siblingUpcs.has(p.upc);
  const cross = products.filter(isCross);
  const rest  = products.filter(p => !isCross(p));
  const crossChosen = cross.length <= cap ? cross : bandedCap(cross, cap, bands, priorityBrands);
  const filled = bandedCap(rest, cap - crossChosen.length, bands, priorityBrands);
  return crossChosen.concat(filled);
}

// ── Phase 4: Update static product prices from live IG data ──────────────────
// Reads data/static-products.json, finds entries that have an Impact Guns seller
// URL, matches them to the live scrape by UPC or numeric product ID embedded in
// the URL, and updates price + stock if they differ. Writes file back in-place.
function updateStaticPrices(allProducts) {
  const staticPath = path.join(__dirname, '..', '..', 'data', 'static-products.json');
  if (!fs.existsSync(staticPath)) {
    console.log('  static-products.json not found — skipping');
    return 0;
  }

  const staticProducts = JSON.parse(fs.readFileSync(staticPath, 'utf8').replace(/^\uFEFF/, ''));

  // Build lookup maps from all Phase-1 scraped products (pre-cap)
  const igByUpc    = {};
  const igByProdId = {};
  for (const p of allProducts) {
    const upc = p.apiUpc || p.upc;
    if (upc) igByUpc[upc] = p;
    igByProdId[p.productId] = p;
  }

  let updatedCount = 0;

  for (const sp of staticProducts) {
    if (!sp.sellers) continue;
    for (const seller of sp.sellers) {
      if (seller.name !== 'Impact Guns') continue;

      // Extract UPC (12–13 digits) and optional numeric product ID from URL slug
      const cleanUrl  = (seller.url || '').split('#')[0];
      const slug      = (cleanUrl.split('/').filter(Boolean).pop() || '');
      const slugParts = slug.split('-');

      let upc = '', numericId = '';
      for (let i = slugParts.length - 1; i >= 0; i--) {
        if (/^\d{12,13}$/.test(slugParts[i])) {
          upc = slugParts[i];
          // Part right after UPC might be numeric product ID
          if (i + 1 < slugParts.length && /^\d{4,6}$/.test(slugParts[i + 1])) {
            numericId = slugParts[i + 1];
          }
          break;
        }
      }

      // Match to live data — UPC preferred, fall back to numeric product ID
      const liveProduct = (upc && igByUpc[upc]) || (numericId && igByProdId[numericId]) || null;
      if (!liveProduct) continue;

      const changes = [];

      // Update price if the live price is valid and different
      if (liveProduct.price > 0 && Math.abs(liveProduct.price - seller.price) >= 0.01) {
        changes.push(`price $${seller.price} → $${liveProduct.price}`);
        seller.price = liveProduct.price;
      }

      // Update stock status
      const liveStock = liveProduct.inStock ? 'in' : 'out';
      if (liveStock !== seller.stock) {
        changes.push(`stock ${seller.stock} → ${liveStock}`);
        seller.stock = liveStock;
      }

      // Fix old affiliate URL format (#IdealArmory → PAP hash)
      if (seller.url && !seller.url.includes('a_aid=')) {
        seller.url = cleanUrl + '#a_aid=IdealArmory&a_cid=71c03b38';
        changes.push('affiliate URL updated');
      }

      if (changes.length > 0) {
        console.log(`  ${sp.id} "${sp.name}": ${changes.join(', ')}`);
        updatedCount++;
      }
    }
  }

  if (updatedCount > 0) {
    fs.writeFileSync(staticPath, JSON.stringify(staticProducts, null, 4));
    console.log(`  ${updatedCount} static product(s) updated`);
  } else {
    console.log('  No static product prices changed');
  }

  return updatedCount;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Impact Guns Catalog Fetch ===');
  console.log(`Started: ${new Date().toISOString()}\n`);

  const seenIds     = new Set();
  const allProducts = [];
  const catMap      = {};   // productId → ourCat

  // ── Phase 1: Scrape listing pages ────────────────────────────────────────
  console.log('Phase 1: Scraping category pages (prices parsed from HTML)...');
  for (const { slug, ourCat } of CATEGORIES) {
    const raw = await scrapeCategory(slug, ourCat, seenIds);
    for (const p of raw) {
      catMap[p.productId] = ourCat;
      allProducts.push(p);
    }
    const htmlPriced = raw.filter(p => p.htmlPriceFound).length;
    console.log(`  /${slug}: ${raw.length} products (${htmlPriced} with HTML price, ${raw.length - htmlPriced} need API)`);
  }

  const htmlPricedTotal = allProducts.filter(p => p.htmlPriceFound).length;
  const needApiTotal    = allProducts.length - htmlPricedTotal;
  console.log(`\nPhase 1 done: ${allProducts.length} total unique products`);
  console.log(`  HTML prices: ${htmlPricedTotal} | Need API: ${needApiTotal}\n`);

  if (allProducts.length < 50) {
    console.error(`QUALITY GATE (phase 1): Only ${allProducts.length} products — likely a scrape failure.`);
    process.exit(1);
  }

  // ── Phase 2: Enrich missing prices via BigCommerce API ───────────────────
  if (needApiTotal > 0) {
    console.log('Phase 2: Fetching prices from BigCommerce API (only for price=0 products)...');
    await enrichWithApi(allProducts);
  } else {
    console.log('Phase 2: Skipped — all prices available from listing HTML.');
  }

  // ── Phase 3: Filter, group, write ────────────────────────────────────────
  console.log('\nPhase 3: Filtering and writing output...');
  const byCategory  = {};
  let totalRelevant = 0;

  for (const raw of allProducts) {
    const ourCat = catMap[raw.productId];
    if (!isRelevant(raw, ourCat)) continue;
    if (!byCategory[ourCat]) byCategory[ourCat] = [];
    byCategory[ourCat].push(transformProduct(raw, ourCat));
    totalRelevant++;
  }

  // Category breakdown
  console.log('\nCategory breakdown:');
  for (const [cat, prods] of Object.entries(byCategory)) {
    console.log(`  ${cat}: ${prods.length}`);
  }

  if (totalRelevant < 100) {
    console.error(`QUALITY GATE (phase 3): Only ${totalRelevant} relevant products after filtering.`);
    console.error('  This may mean the price floor filtered everything out, or both HTML and API price parsing failed.');
    process.exit(1);
  }

  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const catCounts    = {};
  const filesWritten = [];

  for (const [cat, products] of Object.entries(byCategory)) {
    if (products.length === 0) continue;
    const prioBrands = PRIORITY_BRANDS[cat] || [];
    const cap = CAT_CAPS[cat];
    const bands = PRICE_BANDS[cat];

    let final;
    if (cap && products.length > cap && bands && prioBrands.length) {
      // Firearm categories: prefer in-stock, but sample evenly across price bands
      // instead of pure listing order — otherwise a glut of cheap listings can
      // still crowd out the $500-1500+ range even with priority brands preferred.
      const inStock = products.filter(p => p.inStock);
      const pool = inStock.length >= cap ? inStock : products;
      const siblingUpcs = loadSiblingUpcs(dataDir, cat);
      const crossCount = pool.filter(p => p.upc && siblingUpcs.has(p.upc)).length;
      final = bandedCapWithCrossMatch(pool, cap, bands, prioBrands, siblingUpcs).sort((a, b) => a.price - b.price);
      console.log(`  [cap:banded+crossmatch] ${cat}: ${products.length} → ${final.length} (${Math.min(crossCount, cap)} cross-retailer matches guaranteed)`);
    } else {
      // Sort: in-stock first, then priority brands before others, then preserve listing order.
      // Priority brands ensure popular hunting/sporting manufacturers (Tikka, Ruger, etc.)
      // aren't pushed out by Impact Guns' "featured" listing when the cap is applied.
      const isPrio = p => prioBrands.some(br => (p.brand || p.name || '').toLowerCase().includes(br));
      products.sort((a, b) => {
        if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
        const ap = isPrio(a), bp = isPrio(b);
        if (ap !== bp) return ap ? -1 : 1;
        return 0;
      });
      final = cap && products.length > cap ? products.slice(0, cap) : products;
      if (cap && products.length > cap) console.log(`  [cap] ${cat}: ${products.length} → ${cap}`);
    }

    catCounts[cat] = final.length;
    const fname    = `impactguns-${cat}.json`;
    fs.writeFileSync(path.join(dataDir, fname), JSON.stringify(final));
    const kb = Math.round(fs.statSync(path.join(dataDir, fname)).size / 1024);
    console.log(`  Wrote ${fname}: ${final.length} products (${kb} KB)`);
    filesWritten.push(fname);
  }

  // ── Phase 4: Sync static product prices from live scrape data ───────────
  console.log('\nPhase 4: Updating static product prices from live data...');
  const staticUpdates = updateStaticPrices(allProducts);

  // productCount reflects what was actually written (post-cap) — totalRelevant is
  // the pre-cap "matched filters" total, logged separately for reference.
  const productCount = Object.values(catCounts).reduce((n, c) => n + c, 0);
  fs.writeFileSync(
    path.join(dataDir, 'impactguns-last-run.json'),
    JSON.stringify({
      lastRun:        new Date().toISOString(),
      productCount,
      rawCount:       allProducts.length,
      htmlPriced:     htmlPricedTotal,
      apiEnriched:    allProducts.filter(p => !p.htmlPriceFound && p.price > 0).length,
      staticUpdated:  staticUpdates,
      categories:     catCounts,
      files:          filesWritten,
      status:         'success',
    }, null, 2)
  );

  console.log(`\n========================================`);
  console.log(` SUCCESS — ${productCount} products across ${filesWritten.length} categories (${totalRelevant} matched filters before per-category caps)`);
  if (staticUpdates > 0) console.log(` Static prices updated: ${staticUpdates}`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
