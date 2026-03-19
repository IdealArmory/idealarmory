// fetch-eurooptic.js
// Fetches EuroOptic product catalog from Impact.com API
// Writes data/eurooptic-catalog.json and data/eurooptic-last-run.json

const fs   = require('fs');
const path = require('path');

const ACCOUNT_SID = process.env.IMPACT_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.IMPACT_AUTH_TOKEN;
const CATALOG_ID  = process.env.IMPACT_CATALOG_ID;

if (!ACCOUNT_SID || !AUTH_TOKEN || !CATALOG_ID) {
  console.error('ERROR: Missing required environment variables.');
  process.exit(1);
}

const BASE_URL    = `https://api.impact.com/Mediapartners/${ACCOUNT_SID}/Catalogs/${CATALOG_ID}/Items`;
const AUTH_HEADER = 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

const KNOWN_CATEGORIES = ['rifles','handguns','optics','ammunition','holsters','magazines','cleaning','gun-safes','ar-parts'];

// Also filter by product name keywords to catch items EuroOptic miscategorizes
const NAME_EXCLUDE_KEYWORDS = ['jacket','shirt','pants','boot','shoe','sock','hat','cap','glove','backpack','bag','vest','fleece','hoodie','sweater','pant','short','trouser','underwear','balaclava','buff','gaiter','beanie'];

function mapCategory(cat) {
  const c = (cat || '').toLowerCase();
  if (c.includes('rifle') || c.includes('shotgun'))                            return 'rifles';
  if (c.includes('handgun') || c.includes('pistol') || c.includes('revolver')) return 'handguns';
  if (c.includes('optic') || c.includes('scope') || c.includes('sight') || c.includes('binocular') || c.includes('rangefinder')) return 'optics';
  if (c.includes('ammo') || c.includes('ammunition'))                          return 'ammunition';
  if (c.includes('holster'))                                                   return 'holsters';
  if (c.includes('magazine') || c.includes('mag'))                             return 'magazines';
  if (c.includes('cleaning') || c.includes('maintenance'))                     return 'cleaning';
  if (c.includes('safe') || c.includes('storage'))                             return 'gun-safes';
  if (c.includes('ar') || c.includes('parts') || c.includes('accessory') || c.includes('accessories')) return 'ar-parts';
  return 'other';
}

function isRelevant(item, category) {
  if (category === 'other') return false;
  const name = (item.Name || '').toLowerCase();
  if (NAME_EXCLUDE_KEYWORDS.some(kw => name.includes(kw))) return false;
  return true;
}

function transformProduct(item) {
  return {
    id:            String(item.CatalogItemId || item.Id || ''),
    upc:           item.Upc || item.UPC || '',
    brand:         item.Manufacturer || item.BrandName || item.Brand || '',
    name:          item.Name || '',
    description:   item.Description || '',
    price:         parseFloat(item.CurrentPrice || item.SalePrice || 0),
    originalPrice: parseFloat(item.OriginalPrice || item.CurrentPrice || 0),
    img:           item.ImageUrl || (item.AdditionalImageUrls && item.AdditionalImageUrls[0]) || '',
    url:           item.Url || item.TrackingLink || '',
    category:      mapCategory(item.Category || item.ProductType || ''),
    inStock:       item.OutOfStock === false || item.OutOfStock === 'false' || item.Availability === 'In Stock',
    lastUpdated:   new Date().toISOString(),
    source:        'eurooptic'
  };
}

// ── Fetch with retry ──────────────────────────────────────────────────────────
async function fetchUrl(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch(url, {
      headers: { 'Authorization': AUTH_HEADER, 'Accept': 'application/json' }
    });

    if (response.ok) return response.json();

    const body = await response.text();
    console.warn(`  Attempt ${attempt}/${retries} failed: ${response.status} — ${body.substring(0, 200)}`);

    if (attempt < retries) await sleep(3000 * attempt); // 3s, 6s backoff
  }
  throw new Error(`Failed after ${retries} attempts`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== EuroOptic Catalog Fetch ===');
  console.log(`Catalog ID : ${CATALOG_ID}`);
  console.log(`Started    : ${new Date().toISOString()}`);
  console.log('');

  let allProducts   = [];
  let pageNum       = 1;
  let totalExpected = null;
  let nextUrl       = `${BASE_URL}?PageSize=500`;

  while (nextUrl) {
    console.log(`Fetching page ${pageNum}... (${nextUrl.split('?')[1]})`);
    const data = await fetchUrl(nextUrl);

    // Capture total on first page
    if (pageNum === 1) {
      totalExpected = parseInt(data['@total'] || data.TotalCount || 0) || null;
      if (totalExpected) console.log(`Total products expected: ${totalExpected}`);
      console.log('Sample item:');
      const sample = (data.Items || [])[0];
      if (sample) console.log(JSON.stringify(sample, null, 2).substring(0, 600));
    }

    const items = data.Items || data.CatalogItems || [];
    if (!items.length) {
      console.log('No items returned — done.');
      break;
    }

    let pageKept = 0;
    let pageSkipped = 0;
    for (const item of items) {
      const transformed = transformProduct(item);
      if (isRelevant(item, transformed.category)) {
        allProducts.push(transformed);
        pageKept++;
      } else {
        pageSkipped++;
      }
    }
    console.log(`  → kept ${pageKept}, skipped ${pageSkipped} (total kept: ${allProducts.length})`);

    // Follow cursor-based next page URI
    const nextPageUri = data['@nextpageuri'] || data.NextPageUri || '';
    if (nextPageUri) {
      nextUrl = `https://api.impact.com${nextPageUri}`;
      pageNum++;
      await sleep(500); // small delay to avoid rate limiting
    } else {
      nextUrl = null;
    }
  }

  // ── Quality gate ──────────────────────────────────────────────────────────
  if (allProducts.length === 0) {
    console.error('QUALITY GATE FAILED: Zero products returned.');
    process.exit(1);
  }
  // Quality gate: expect at least 1,000 relevant products from EuroOptic's catalog
  if (allProducts.length < 1000) {
    console.error(`QUALITY GATE FAILED: Only ${allProducts.length} relevant products found — expected at least 1,000.`);
    process.exit(1);
  }

  // ── Write output ──────────────────────────────────────────────────────────
  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'eurooptic-catalog.json'), JSON.stringify(allProducts, null, 2));
  fs.writeFileSync(path.join(dataDir, 'eurooptic-last-run.json'), JSON.stringify({
    lastRun: new Date().toISOString(), productCount: allProducts.length,
    totalExpected, pagesProcessed: pageNum, status: 'success'
  }, null, 2));

  console.log('');
  console.log(`SUCCESS: ${allProducts.length} products written to data/eurooptic-catalog.json`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
