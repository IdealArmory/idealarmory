// fetch-luckygunner.js
// Fetches Lucky Gunner in-stock product feed (Google Shopping RSS/XML).
// Feed is publicly accessible — no credentials required.
// Writes: data/luckygunner-ammunition.json + data/luckygunner-last-run.json
//
// Feed URL: https://www.luckygunner.com/media/feeds/lg_feed_in_stock_only.xml
// XML format: RSS 2.0 with g: (Google Base) namespace
//   <item>
//     <title>40 S&W - 165 Grain TMJ - Speer LAWMAN - 50 Rounds</title>
//     <link>https://www.luckygunner.com/...</link>
//     <g:id>abc123</g:id>
//     <g:price>20.00 USD</g:price>
//     <g:image_link>https://cdn.luckygunner.com/...</g:image_link>
//     <g:gtin>076683539557</g:gtin>
//     <g:brand>Speer</g:brand>
//     <g:caliber>.40 S&W</g:caliber>
//     <g:quantity>50</g:quantity>
//     <g:bullet_type>Total Metal Jacket (TMJ)</g:bullet_type>
//     <g:bullet_weight>165 Grain</g:bullet_weight>
//     <g:ammo_casing>Brass</g:ammo_casing>
//     <g:product_review_average>4.97</g:product_review_average>
//     <g:product_review_count>10</g:product_review_count>
//     <g:availability>in stock</g:availability>
//   </item>

const fs   = require('fs');
const path = require('path');

const FEED_URL = 'https://www.luckygunner.com/media/feeds/lg_feed_in_stock_only.xml';

// ── XML helpers ──────────────────────────────────────────────────────────────

function decodeXml(str) {
  return (str || '')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g,  "'");
}

// Extract a namespaced tag: <g:field>value</g:field> or <g:field><![CDATA[value]]></g:field>
function getG(block, name) {
  const re = new RegExp(`<g:${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/g:${name}>`, '');
  const m  = block.match(re);
  return m ? decodeXml(m[1].trim()) : '';
}

// Extract a plain tag: <title>value</title> or <title><![CDATA[value]]></title>
function getTag(block, name) {
  const re = new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, '');
  const m  = block.match(re);
  return m ? decodeXml(m[1].trim()) : '';
}

// ── Feed parser ──────────────────────────────────────────────────────────────

function parseFeed(xml) {
  const items  = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;

  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];

    const id           = getG(block, 'id');
    const title        = getTag(block, 'title');
    const link         = getTag(block, 'link');
    const priceRaw     = getG(block, 'price');
    const saleRaw      = getG(block, 'sale_price');
    const imageLink    = getG(block, 'image_link');
    const availability = getG(block, 'availability');
    const brand        = getG(block, 'brand');
    const gtin         = getG(block, 'gtin');
    const mpn          = getG(block, 'mpn');
    const caliber      = getG(block, 'caliber');
    const quantity     = getG(block, 'quantity');
    const bulletType   = getG(block, 'bullet_type');
    const bulletWeight = getG(block, 'bullet_weight');
    const casing       = getG(block, 'ammo_casing');
    const reviewAvg    = getG(block, 'product_review_average');
    const reviewCount  = getG(block, 'product_review_count');
    const productType  = getG(block, 'product_type');

    if (!id || !title || !link) continue;

    // Price — prefer sale_price when present
    const price = parseFloat(saleRaw || priceRaw) || 0;

    // Normalize GTIN: strip leading zeros for reliable UPC cross-matching
    const upc = gtin ? String(parseInt(gtin, 10)) : '';

    // Rounds count from quantity field or infer from title
    let qty = parseInt(quantity, 10) || 0;
    if (!qty) {
      const qm = title.match(/(\d+)\s*(?:rounds?|rds?|count|ct)\b/i);
      if (qm) qty = parseInt(qm[1], 10);
    }
    if (!qty) qty = 1;

    items.push({
      id:          'lg_' + id,
      brand:       brand || 'Lucky Gunner',
      name:        title,
      url:         link,
      img:         imageLink || '',
      price,
      upc,
      mpn:         mpn || '',
      caliber:     caliber || '',
      qty,
      btype:       bulletType   || '',
      grain:       bulletWeight || '',
      casing:      casing       || '',
      stars:       parseFloat(reviewAvg)  || 0,
      reviews:     parseInt(reviewCount, 10) || 0,
      inStock:     availability.toLowerCase() === 'in stock',
      productType: productType || '',
      src:         'luckygunner',
    });
  }
  return items;
}

// ── Filter ───────────────────────────────────────────────────────────────────

function isRelevant(item) {
  if (!item.inStock)    return false;
  if (!item.img)        return false;
  if (item.price < 5)   return false;
  if (!item.name)       return false;
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Lucky Gunner Catalog Fetch ===');
  console.log(`Feed URL : ${FEED_URL}`);
  console.log(`Started  : ${new Date().toISOString()}\n`);

  // Download feed
  console.log('Downloading XML feed...');
  let xml;
  try {
    const res = await fetch(FEED_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IdealArmory/1.0; +https://idealarmory.com)',
        'Accept': 'text/xml,application/xml,application/rss+xml,*/*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`);
    xml = await res.text();
    console.log(`Downloaded: ${(xml.length / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.error(`Feed download failed: ${err.message}`);
    process.exit(1);
  }

  // Parse
  console.log('Parsing XML...');
  const rawItems = parseFeed(xml);
  console.log(`Total items parsed: ${rawItems.length}`);

  if (rawItems.length < 20) {
    console.error(`QUALITY GATE FAILED: Only ${rawItems.length} items — feed may be empty or malformed.`);
    process.exit(1);
  }

  // Filter
  const products = rawItems.filter(isRelevant);
  console.log(`In-stock with images: ${products.length} / ${rawItems.length}`);

  // Caliber breakdown
  const caliberCounts = {};
  products.forEach(p => {
    const cal = p.caliber || p.productType || 'Unknown';
    caliberCounts[cal] = (caliberCounts[cal] || 0) + 1;
  });
  console.log('\nCaliber breakdown:');
  Object.entries(caliberCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  // Write output
  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const outFile = path.join(dataDir, 'luckygunner-ammunition.json');
  fs.writeFileSync(outFile, JSON.stringify(products));
  const kb = Math.round(fs.statSync(outFile).size / 1024);
  console.log(`\nWrote luckygunner-ammunition.json: ${products.length} products (${kb} KB)`);

  // Last-run metadata
  fs.writeFileSync(
    path.join(dataDir, 'luckygunner-last-run.json'),
    JSON.stringify({
      lastRun:      new Date().toISOString(),
      productCount: products.length,
      rawCount:     rawItems.length,
      calibers:     caliberCounts,
      status:       'success',
    }, null, 2)
  );

  console.log('\n========================================');
  console.log(` SUCCESS — ${products.length} Lucky Gunner ammo products`);
  console.log('========================================');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
