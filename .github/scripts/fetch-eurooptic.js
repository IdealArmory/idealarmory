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

const AUTH_HEADER = 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');

// URL formats to try in order
const CANDIDATE_URLS = [
  `https://api.impact.com/Affiliates/${ACCOUNT_SID}/Catalogs/${CATALOG_ID}/Items`,
  `https://api.impact.com/MediaPartners/${ACCOUNT_SID}/Catalogs/${CATALOG_ID}/Items`,
  `https://api.impact.com/Affiliates/${ACCOUNT_SID}/Catalogs/${CATALOG_ID}/CatalogItems`,
  `https://api.impact.com/MediaPartners/${ACCOUNT_SID}/Catalogs/${CATALOG_ID}/CatalogItems`,
];

// ── Category mapping ─────────────────────────────────────────────────────────
function mapCategory(cat) {
  const c = (cat || '').toLowerCase();
  if (c.includes('rifle') || c.includes('shotgun'))                            return 'rifles';
  if (c.includes('handgun') || c.includes('pistol') || c.includes('revolver')) return 'handguns';
  if (c.includes('optic') || c.includes('scope') || c.includes('sight'))       return 'optics';
  if (c.includes('ammo') || c.includes('ammunition'))                          return 'ammunition';
  if (c.includes('holster'))                                                   return 'holsters';
  if (c.includes('magazine') || c.includes('mag'))                             return 'magazines';
  if (c.includes('cleaning') || c.includes('maintenance'))                     return 'cleaning';
  if (c.includes('safe') || c.includes('storage'))                             return 'gun-safes';
  if (c.includes('ar') || c.includes('parts'))                                 return 'ar-parts';
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

// ── Try each candidate URL until one works ───────────────────────────────────
async function findWorkingUrl() {
  for (const url of CANDIDATE_URLS) {
    console.log(`Trying: ${url}`);
    const response = await fetch(`${url}?PageSize=1&Page=1`, {
      headers: { 'Authorization': AUTH_HEADER, 'Accept': 'application/json' }
    });
    const body = await response.text();
    console.log(`  Status: ${response.status}`);
    console.log(`  Response: ${body.substring(0, 500)}`);
    if (response.ok) {
      console.log(`  ✓ Working URL found!`);
      return url;
    }
  }
  return null;
}

// ── Fetch a single page ──────────────────────────────────────────────────────
async function fetchPage(baseUrl, pageNumber) {
  const url = `${baseUrl}?PageSize=500&Page=${pageNumber}`;
  const response = await fetch(url, {
    headers: { 'Authorization': AUTH_HEADER, 'Accept': 'application/json' }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API error on page ${pageNumber}: ${response.status} — ${body.substring(0, 300)}`);
  }
  return response.json();
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== EuroOptic Catalog Fetch ===');
  console.log(`Catalog ID : ${CATALOG_ID}`);
  console.log(`Started    : ${new Date().toISOString()}`);
  console.log('');

  // Step 1: Find the working endpoint URL
  console.log('--- Step 1: Finding working API endpoint ---');
  const workingUrl = await findWorkingUrl();

  if (!workingUrl) {
    console.error('');
    console.error('ERROR: None of the candidate URLs returned a successful response.');
    console.error('Check that your Account SID, Auth Token, and Catalog ID are correct.');
    process.exit(1);
  }

  console.log('');
  console.log(`--- Step 2: Fetching full catalog from ${workingUrl} ---`);

  let allProducts   = [];
  let page          = 1;
  let totalExpected = null;

  while (true) {
    console.log(`Fetching page ${page}...`);
    const data  = await fetchPage(workingUrl, page);
    const items = data.Items || data.CatalogItems || data.items || (Array.isArray(data) ? data : []);

    if (!Array.isArray(items) || items.length === 0) {
      console.log(`Page ${page} returned no items — done.`);
      break;
    }

    if (page === 1) {
      totalExpected = data.TotalCount || data.Total || data.totalCount || null;
      if (totalExpected) console.log(`Total products expected: ${totalExpected}`);
      console.log('Sample item:');
      console.log(JSON.stringify(items[0], null, 2).substring(0, 800));
    }

    allProducts = allProducts.concat(items.map(transformProduct));
    console.log(`  → ${items.length} items (total: ${allProducts.length})`);
    if (items.length < 500) break;
    page++;
  }

  // ── Quality gate ───────────────────────────────────────────────────────────
  if (allProducts.length === 0) {
    console.error('QUALITY GATE FAILED: Zero products returned.');
    process.exit(1);
  }
  if (totalExpected && allProducts.length < totalExpected * 0.95) {
    console.error(`QUALITY GATE FAILED: Got ${allProducts.length}/${totalExpected} products.`);
    process.exit(1);
  }

  // ── Write output ───────────────────────────────────────────────────────────
  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'eurooptic-catalog.json'), JSON.stringify(allProducts, null, 2));
  fs.writeFileSync(path.join(dataDir, 'eurooptic-last-run.json'), JSON.stringify({
    lastRun: new Date().toISOString(), productCount: allProducts.length,
    totalExpected, pagesProcessed: page, status: 'success'
  }, null, 2));

  console.log('');
  console.log(`SUCCESS: ${allProducts.length} products written to data/eurooptic-catalog.json`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
