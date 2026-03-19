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
  console.error('Required: IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN, IMPACT_CATALOG_ID');
  process.exit(1);
}

const AUTH_HEADER = 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');

// ── Category mapping ─────────────────────────────────────────────────────────
function mapCategory(cat) {
  const c = (cat || '').toLowerCase();
  if (c.includes('rifle') || c.includes('shotgun'))            return 'rifles';
  if (c.includes('handgun') || c.includes('pistol') || c.includes('revolver')) return 'handguns';
  if (c.includes('optic') || c.includes('scope') || c.includes('sight'))       return 'optics';
  if (c.includes('ammo') || c.includes('ammunition'))          return 'ammunition';
  if (c.includes('holster'))                                   return 'holsters';
  if (c.includes('magazine') || c.includes('mag'))             return 'magazines';
  if (c.includes('cleaning') || c.includes('maintenance'))     return 'cleaning';
  if (c.includes('safe') || c.includes('storage'))             return 'gun-safes';
  if (c.includes('ar') || c.includes('parts'))                 return 'ar-parts';
  return 'other';
}

// ── Transform Impact.com item → Ideal Armory schema ─────────────────────────
function transformProduct(item) {
  return {
    id:            String(item.Id || item.CatalogItemId || ''),
    upc:           item.Upc || item.UPC || '',
    brand:         item.BrandName || item.Brand || item.ManufacturerName || '',
    name:          item.Name || item.ProductName || '',
    description:   item.Description || '',
    price:         parseFloat(item.SalePrice || item.CurrentPrice || item.Price || 0),
    originalPrice: parseFloat(item.CurrentPrice || item.RegularPrice || 0),
    img:           item.ImageUrl || item.Image || '',
    url:           item.TrackingLink || item.DeepLink || '',
    category:      mapCategory(item.Category || item.ProductType || ''),
    inStock:       (item.Availability || '').toString().toLowerCase().includes('in'),
    lastUpdated:   new Date().toISOString(),
    source:        'eurooptic'
  };
}

// ── List all available catalogs (diagnostic step) ────────────────────────────
async function listCatalogs() {
  const url = `https://api.impact.com/Affiliates/${ACCOUNT_SID}/Catalogs`;
  console.log(`Listing catalogs at: ${url}`);
  const response = await fetch(url, {
    headers: {
      'Authorization': AUTH_HEADER,
      'Accept':        'application/json'
    }
  });
  console.log(`Catalogs endpoint status: ${response.status}`);
  const text = await response.text();
  console.log(`Catalogs response: ${text.substring(0, 2000)}`);
  return response.ok ? JSON.parse(text) : null;
}

// ── Fetch a single page from the API ────────────────────────────────────────
async function fetchPage(catalogId, pageNumber) {
  const url = `https://api.impact.com/Affiliates/${ACCOUNT_SID}/Catalogs/${catalogId}/Items?PageSize=500&Page=${pageNumber}`;
  console.log(`  GET ${url}`);
  const response = await fetch(url, {
    headers: {
      'Authorization': AUTH_HEADER,
      'Accept':        'application/json'
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API error on page ${pageNumber}: ${response.status} ${response.statusText} — ${body.substring(0, 500)}`);
  }

  return response.json();
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== EuroOptic Catalog Fetch ===');
  console.log(`Account SID : ${ACCOUNT_SID}`);
  console.log(`Catalog ID  : ${CATALOG_ID}`);
  console.log(`Started     : ${new Date().toISOString()}`);
  console.log('');

  // Step 1: List all catalogs to confirm correct ID
  console.log('--- Step 1: Listing available catalogs ---');
  const catalogs = await listCatalogs();
  console.log('');

  // Step 2: Fetch items using configured catalog ID
  console.log(`--- Step 2: Fetching items for Catalog ID ${CATALOG_ID} ---`);

  let allProducts  = [];
  let page         = 1;
  let totalExpected = null;

  while (true) {
    console.log(`Fetching page ${page}...`);
    const data  = await fetchPage(CATALOG_ID, page);
    const items = data.Items || data.CatalogItems || data.items || (Array.isArray(data) ? data : []);

    if (!Array.isArray(items) || items.length === 0) {
      console.log(`Page ${page} returned no items — done paginating.`);
      break;
    }

    if (page === 1) {
      totalExpected = data.TotalCount || data.Total || data.totalCount || null;
      if (totalExpected) console.log(`Total products advertised by API: ${totalExpected}`);
      // Print first item as a sample to verify data shape
      console.log('Sample item (first product):');
      console.log(JSON.stringify(items[0], null, 2).substring(0, 1000));
    }

    const transformed = items.map(transformProduct);
    allProducts = allProducts.concat(transformed);
    console.log(`  → ${items.length} items (running total: ${allProducts.length})`);

    if (items.length < 500) break;
    page++;
  }

  console.log('');

  // ── Quality gate ───────────────────────────────────────────────────────────
  if (allProducts.length === 0) {
    console.error('QUALITY GATE FAILED: Zero products returned. Aborting.');
    process.exit(1);
  }

  if (totalExpected && allProducts.length < totalExpected * 0.95) {
    console.error(`QUALITY GATE FAILED`);
    console.error(`  Expected : ${totalExpected}`);
    console.error(`  Received : ${allProducts.length} (${Math.round(allProducts.length / totalExpected * 100)}%)`);
    process.exit(1);
  }

  // ── Write output files ─────────────────────────────────────────────────────
  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(
    path.join(dataDir, 'eurooptic-catalog.json'),
    JSON.stringify(allProducts, null, 2)
  );

  const runMeta = {
    lastRun:        new Date().toISOString(),
    productCount:   allProducts.length,
    totalExpected:  totalExpected,
    pagesProcessed: page,
    status:         'success'
  };

  fs.writeFileSync(
    path.join(dataDir, 'eurooptic-last-run.json'),
    JSON.stringify(runMeta, null, 2)
  );

  console.log(`SUCCESS`);
  console.log(`  Products written : ${allProducts.length}`);
  console.log(`  Pages processed  : ${page}`);
  console.log(`  Output           : data/eurooptic-catalog.json`);
  console.log(`  Metadata         : data/eurooptic-last-run.json`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
