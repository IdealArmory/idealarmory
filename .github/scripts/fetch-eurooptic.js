// fetch-eurooptic.js
// Fetches EuroOptic catalog via Impact.com /Files endpoint (single download)
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

const AUTH_HEADER  = 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
const FILES_URL    = `https://api.impact.com/Mediapartners/${ACCOUNT_SID}/Catalogs/${CATALOG_ID}/Files`;
const ITEMS_URL    = `https://api.impact.com/Mediapartners/${ACCOUNT_SID}/Catalogs/${CATALOG_ID}/Items`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Category mapping ──────────────────────────────────────────────────────────
const NAME_EXCLUDE_KEYWORDS = [
  'jacket','shirt','pants','boot','shoe','sock','hat','cap','glove',
  'backpack','bag','vest','fleece','hoodie','sweater','pant','short',
  'trouser','underwear','balaclava','buff','gaiter','beanie','apparel','clothing'
];

function mapCategory(cat, name) {
  const c = (cat  || '').toLowerCase();
  const n = (name || '').toLowerCase();
  const t = c + ' ' + n;
  if (t.includes('rifle') || t.includes('shotgun'))                                         return 'rifles';
  if (t.includes('handgun') || t.includes('pistol') || t.includes('revolver'))              return 'handguns';
  if (t.includes('optic') || t.includes('scope') || t.includes('sight') ||
      t.includes('binocular') || t.includes('rangefinder') || t.includes('night vision'))   return 'optics';
  if (t.includes('ammo') || t.includes('ammunition') || t.includes('bullet') ||
      t.includes('cartridge') || t.includes('round'))                                        return 'ammunition';
  if (t.includes('holster'))                                                                 return 'holsters';
  if (t.includes('magazine') || t.includes(' mag ') || t.includes('mag,'))                  return 'magazines';
  if (t.includes('cleaning') || t.includes('maintenance') || t.includes('solvent') ||
      t.includes('lubricant') || t.includes('bore'))                                         return 'cleaning';
  if (t.includes('safe') || t.includes('vault') || t.includes('storage'))                   return 'gun-safes';
  if (t.includes('ar-') || t.includes('ar15') || t.includes('ar10') ||
      t.includes('parts') || t.includes('accessory') || t.includes('accessories') ||
      t.includes('bipod') || t.includes('grip') || t.includes('stock') ||
      t.includes('trigger') || t.includes('suppressor') || t.includes('silencer') ||
      t.includes('muzzle') || t.includes('foregrip') || t.includes('mount') ||
      t.includes('rail') || t.includes('sling') || t.includes('flashlight') ||
      t.includes('light') || t.includes('laser'))                                            return 'ar-parts';
  return 'other';
}

function isRelevant(item) {
  // Must have an image
  const img = item.ImageUrl || (item.AdditionalImageUrls && item.AdditionalImageUrls[0]) || '';
  if (!img) return false;
  // Exclude apparel/footwear by category path first (most reliable)
  const catPath = (item.Category || '').toLowerCase();
  if (catPath.includes('apparel') || catPath.includes('clothing') ||
      catPath.includes('footwear') || catPath.includes('shoe') ||
      catPath.includes('accessories > ') && !catPath.includes('firearm')) {
    // Only allow if it maps to a known gun-related category
  }
  // Must not be apparel/footwear/etc. by name
  const name = (item.Name || '').toLowerCase();
  if (NAME_EXCLUDE_KEYWORDS.some(kw => name.includes(kw))) return false;
  // Must map to a known category
  const cat = mapCategory(item.Category || '', item.Name || '');
  return cat !== 'other';
}

function transformProduct(item) {
  const category = mapCategory(item.Category || '', item.Name || '');
  return {
    id:    String(item.CatalogItemId || item.Id || ''),
    upc:   item.Gtin || '',
    brand: item.Manufacturer || item.BrandName || item.Brand || '',
    name:  item.Name || '',
    price: parseFloat(item.CurrentPrice || item.SalePrice || 0),
    orig:  parseFloat(item.OriginalPrice || item.CurrentPrice || 0),
    img:   item.ImageUrl || (item.AdditionalImageUrls && item.AdditionalImageUrls[0]) || '',
    url:   item.Url || item.TrackingLink || '',
    category,
    inStock: item.StockAvailability === 'InStock',
    src: 'eurooptic'
  };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function apiFetch(url) {
  const res = await fetch(url, {
    headers: { 'Authorization': AUTH_HEADER, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`${res.status} — ${await res.text()}`);
  return res.json();
}

async function downloadText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return res.text();
}

// ── CSV parser (simple, handles quoted fields) ────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map(h => h.replace(/^"|"$/g, '').trim());
  return lines.slice(1).map(line => {
    const vals = line.split('\t').map(v => v.replace(/^"|"$/g, '').trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
}

// ── Strategy 1: Download via Files endpoint ───────────────────────────────────
async function fetchViaFiles() {
  console.log('--- Strategy 1: Catalog Files endpoint ---');
  console.log(`GET ${FILES_URL}`);

  const data = await apiFetch(FILES_URL);
  console.log('Files response:', JSON.stringify(data).substring(0, 500));

  const files = data.Files || data.CatalogFiles || data.items || data.Items || [];
  if (!files.length) {
    console.log('No files available.');
    return null;
  }

  console.log(`Found ${files.length} file(s):`);
  files.forEach((f, i) => console.log(`  [${i}] ${f.Url || f.FileUrl || f.url} (${f.FileType || f.Format || 'unknown'})`));

  // Prefer JSON, then TSV/CSV
  const preferred = files.find(f => (f.FileType || f.Format || '').toLowerCase() === 'json')
    || files.find(f => /tsv|csv|txt/i.test(f.FileType || f.Format || ''))
    || files[0];

  const fileUrl = preferred.Url || preferred.FileUrl || preferred.url;
  console.log(`\nDownloading: ${fileUrl}`);
  const text = await downloadText(fileUrl);
  console.log(`Downloaded ${text.length.toLocaleString()} characters.`);

  // Try JSON first
  try {
    const json = JSON.parse(text);
    const items = Array.isArray(json) ? json : (json.Items || json.items || []);
    console.log(`Parsed as JSON: ${items.length} items`);
    return items;
  } catch (_) {}

  // Fall back to TSV/CSV
  const rows = parseCSV(text);
  console.log(`Parsed as TSV/CSV: ${rows.length} rows`);
  return rows;
}

// ── Strategy 2: Paginated Items with robust retry handling ────────────────────
async function fetchViaItems() {
  console.log('--- Strategy 2: Paginated Items ---');
  const PAGE_SIZE      = 1000;  // doubled from 500 → ~156 pages instead of ~312
  const DELAY_MS       = 3000;  // 3s between pages
  const BATCH_SIZE     = 15;    // pause every 15 pages
  const BATCH_PAUSE_MS = 15000; // 15s batch pause
  const MAX_RETRIES    = 8;
  const WAIT_401_MS    = 60000; // 60s on 401
  const WAIT_NET_MS    = 20000; // 20s on network/timeout error
  const FETCH_TIMEOUT  = 45000; // abort individual fetch after 45s

  let allItems = [];
  let pageNum  = 1;
  let nextUrl  = `${ITEMS_URL}?PageSize=${PAGE_SIZE}`;
  let retries  = 0;

  while (nextUrl) {
    if (pageNum > 1 && (pageNum - 1) % BATCH_SIZE === 0) {
      console.log(`  [Batch pause] Waiting ${BATCH_PAUSE_MS / 1000}s...`);
      await sleep(BATCH_PAUSE_MS);
    }

    console.log(`Fetching page ${pageNum}...`);
    let data;
    let retried = false;

    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      try {
        const res = await fetch(nextUrl, {
          signal: controller.signal,
          headers: { 'Authorization': AUTH_HEADER, 'Accept': 'application/json' }
        });
        clearTimeout(timer);
        if (res.status === 401) {
          const body = await res.text().catch(() => '');
          throw new Error(`401 — ${body}`);
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`${res.status} — ${body}`);
        }
        data = await res.json();
        retries = 0;
        break;
      } catch (err) {
        clearTimeout(timer);
        const is401    = err.message.startsWith('401');
        const isAbort  = err.name === 'AbortError';
        const isNet    = isAbort ||
                         err.message.includes('fetch failed') ||
                         err.message.includes('ECONNRESET') ||
                         err.message.includes('ETIMEDOUT') ||
                         err.message.includes('ENOTFOUND');

        if ((is401 || isNet) && retries < MAX_RETRIES) {
          retries++;
          const waitMs = is401 ? WAIT_401_MS : WAIT_NET_MS;
          const reason = is401 ? '401' : (isAbort ? 'timeout' : 'network error');
          console.warn(`  ${reason} (retry ${retries}/${MAX_RETRIES}) — waiting ${waitMs / 1000}s...`);
          await sleep(waitMs);
          retried = true;
        } else {
          throw err; // exhausted retries or unrecognised error
        }
      }
    }

    const items = data.Items || data.CatalogItems || [];
    if (!items.length) { console.log('No more items.'); break; }

    allItems = allItems.concat(items);
    console.log(`  → ${items.length} items (total raw: ${allItems.length})${retried ? ' [after retry]' : ''}`);

    const nextUri = data['@nextpageuri'] || '';
    nextUrl = nextUri ? `https://api.impact.com${nextUri}` : null;
    pageNum++;
    await sleep(DELAY_MS);
  }

  return allItems;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== EuroOptic Catalog Fetch ===');
  console.log(`Catalog ID : ${CATALOG_ID}`);
  console.log(`Started    : ${new Date().toISOString()}\n`);

  let rawItems = null;

  // Try Files endpoint first (faster, no pagination issues)
  try {
    rawItems = await fetchViaFiles();
  } catch (err) {
    console.warn(`Files strategy failed: ${err.message}`);
  }

  // Fall back to paginated Items if Files didn't work
  if (!rawItems || rawItems.length === 0) {
    console.log('\nFalling back to paginated Items strategy...\n');
    rawItems = await fetchViaItems();
  }

  if (!rawItems || rawItems.length === 0) {
    console.error('FATAL: No products retrieved from either strategy.');
    process.exit(1);
  }

  console.log(`\nTotal raw items: ${rawItems.length}`);
  console.log('Filtering to Ideal Armory relevant categories...');

  const allProducts = rawItems.filter(isRelevant).map(transformProduct);

  // Category summary
  const catCounts = {};
  allProducts.forEach(p => { catCounts[p.category] = (catCounts[p.category] || 0) + 1; });
  console.log('\nCategory breakdown:');
  Object.entries(catCounts).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}`));

  if (allProducts.length < 500) {
    console.error(`QUALITY GATE FAILED: Only ${allProducts.length} relevant products.`);
    process.exit(1);
  }

  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Write one minified JSON file per category (avoids GitHub 100MB limit)
  const byCategory = {};
  allProducts.forEach(p => {
    if (!byCategory[p.category]) byCategory[p.category] = [];
    byCategory[p.category].push(p);
  });

  const filesWritten = [];
  for (const [cat, products] of Object.entries(byCategory)) {
    const fname = `eurooptic-${cat}.json`;
    fs.writeFileSync(path.join(dataDir, fname), JSON.stringify(products));
    const kb = Math.round(fs.statSync(path.join(dataDir, fname)).size / 1024);
    console.log(`  ${fname}: ${products.length} products (${kb} KB)`);
    filesWritten.push(fname);
  }

  fs.writeFileSync(path.join(dataDir, 'eurooptic-last-run.json'), JSON.stringify({
    lastRun: new Date().toISOString(),
    productCount: allProducts.length,
    rawCount: rawItems.length,
    categories: catCounts,
    files: filesWritten,
    status: 'success'
  }));

  console.log(`\nSUCCESS: ${allProducts.length} relevant products written across ${filesWritten.length} category files.`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
