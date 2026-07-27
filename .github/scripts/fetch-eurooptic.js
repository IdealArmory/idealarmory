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

// ── Brand whitelist (major brands only per category) ──────────────────────────
const BRAND_WHITELIST = {
  'handguns':    ['glock','sig sauer','sig','smith & wesson','smith and wesson','springfield','ruger','cz','walther','heckler','h&k','taurus','beretta','kimber','daniel defense','canik','fn america','fn herst','shadow systems','kahr','nighthawk','wilson combat','staccato','magnum research','heritage','charter','rock island','kel-tec','keltec'],
  'rifles':      ['ruger','tikka','weatherby','cva','browning','remington','winchester','bergara','cz','savage','smith & wesson','sig sauer','springfield','daniel defense','cmmg','fn america','fn herst','mossberg','henry','barrett','christensen','howa','stag arms','windham','bushmaster','dpms','armalite','palmetto','psa','lwrc','bcm','bravo company'],
  'optics':      ['leupold','vortex','nightforce','trijicon','eotech','aimpoint','bushnell','crimson trace','sig sauer','burris','swarovski','primary arms','steiner','holosun','zeiss','maven','tract','schmidt','kahles','march','minox','hawke','nikon','weaver','mepro','meprolight','atibal','riton','swampfox','athlon','arken'],
  'ammunition':  ['federal','hornady','winchester','remington','cci','speer','nosler','barnes','pmc','magtech','fiocchi','wolf','sellier','blazer','american eagle','corbon','buffalo bore','liberty','black hills','aguila','nato','prvi','tulammo'],
  'holsters':    ['alien gear','blackhawk','safariland','galco','desantis','crossbreed','bianchi','uncle','vedder','we the people','blackpoint','fobus','serpa','tulster','tier 1','t1c','hidden hybrid','cloak','bravo concealment','concealment express','rounded','gun daddy','mod 1','1791','craft holsters','tagua','leather','nylon','kydex','iwb','owb','shoulder','ankle','drop leg'],
  'ar-parts':    ['magpul','bcm','bravo company','aero precision','daniel defense','geissele','larue','yhm','yankee hill','noveske','spike','wilson combat','alg','fortis','surefire','silencerco','kac','knight','lwrc','midwest industries','yankee hill','phase 5','cmmg','seekins','rise armament'],
  'magazines':   ['magpul','ets','promag','lancer','hexmag','kci','glock','beretta','fn','sig','cz'],
  'cleaning':    ["hoppe's",'hoppes','break-free','otis','bore snake','tipton','real avid','sentry','ballistol','mpro','m-pro','tetra','slip 2000','clenzoil','wipe-out','shooter','froglube'],
  'gun-safes':   ['liberty','cannon','fort knox','browning','american security','amsec','stack-on','vaultek','hornady','gunvault','barska','sentrysafe','rhino','mesa','hollon','winchester','secure','safe','vault','steelwater','sentry','v-line','bulldog','pelican','nanuk','case','box','locker','cabinet','rack']
};

// ── Price floors per category ─────────────────────────────────────────────────
const PRICE_FLOORS = {
  'handguns':   400,
  'rifles':     300,  // lowered 500→300 to catch budget hunting/rimfire rifles
  'optics':     250,
  'ammunition':  40,
  'holsters':    20,
  'ar-parts':   300,
  'magazines':   40,
  'cleaning':    30,
  'gun-safes':  100
};

// ── Price CEILINGS per category (products above this are excluded) ────────────
// Rifles $3,000+ are ultra-premium/custom and searched far less than
// popular hunting/sporting rifles in the $300–$2,999 range.
const PRICE_CEILINGS = {
  'rifles': 3000
};

// ── Max products per category ─────────────────────────────────────────────────
const CAT_CAPS = {
  'handguns':   500,
  'rifles':     800,  // priority brands fill first (price asc), then non-priority fill
  'optics':     600,
  'ammunition': 400,
  'holsters':   200,
  'ar-parts':   350,
  'magazines':  250,
  'cleaning':   100,
  'gun-safes':  200
};

function isMajorBrand(brand, category) {
  const b = (brand || '').toLowerCase();
  if (!b) return false;
  const list = BRAND_WHITELIST[category] || [];
  return list.some(kw => b.includes(kw));
}

function mapCategory(cat, name) {
  const c = (cat  || '').toLowerCase();
  const n = (name || '').toLowerCase();
  const t = c + ' ' + n;
  // Specific accessories/gear first — prevents broad firearm terms (pistol, rifle)
  // from swallowing holsters, ammo, optics, etc.
  if (t.includes('holster'))                                                                 return 'holsters';
  if (t.includes('magazine') || t.includes(' mag ') || t.includes('mag,'))                  return 'magazines';
  if (t.includes('cleaning') || t.includes('maintenance') || t.includes('solvent') ||
      t.includes('lubricant') || t.includes('bore') || t.includes('brush') ||
      t.includes('patch') || t.includes('cleaner') || t.includes('lube ') ||
      t.includes('oil ') || t.includes('degreaser'))                                         return 'cleaning';
  if (t.includes('safe') || t.includes('vault') || t.includes('storage'))                   return 'gun-safes';
  // Cases/pouches/accessories — reject before firearm keyword matching
  if (t.includes(' case') || t.includes(' pouch') || t.includes(' rug ') ||
      t.includes(' bag ') || t.includes(' mat ') || t.includes(' sleeve') ||
      t.includes('adapter') || t.includes(' cover ') || t.includes('protector') ||
      t.includes(' wrap ') || t.includes('spacer') || t.includes('buttpad'))                return 'other';
  if (t.includes('ammo') || t.includes('ammunition') || t.includes('bullet') ||
      t.includes('cartridge') || t.includes('round') || t.includes('powder') ||
      t.includes('primer') || t.includes('projectile') || t.includes(' rds') ||
      t.includes(' rd,') || t.includes(' gr.') || t.includes('grain ') ||
      t.includes('fmj') || t.includes('jhp') || t.includes('subsonic') ||
      t.includes('buckshot') || t.includes('birdshot') || t.includes('slug'))               return 'ammunition';
  if (t.includes('optic') || t.includes('scope') || t.includes('sight') ||
      t.includes('binocular') || t.includes('rangefinder') || t.includes('night vision'))   return 'optics';
  // AR parts — check pistol-length/pistol-grip descriptors BEFORE handgun keywords
  if (t.includes('ar-') || t.includes('ar15') || t.includes('ar10') ||
      t.includes('parts') || t.includes('accessory') || t.includes('accessories') ||
      t.includes('bipod') || t.includes('grip') || t.includes('stock') ||
      t.includes('trigger') || t.includes('suppressor') || t.includes('silencer') ||
      t.includes('muzzle') || t.includes('foregrip') || t.includes('mount') ||
      t.includes('rail') || t.includes('sling') || t.includes('flashlight') ||
      t.includes('light') || t.includes('laser') || t.includes('gas tube') ||
      t.includes('gas block') || t.includes('bolt carrier') || t.includes('handguard') ||
      t.includes('pistol length') || t.includes('pistol grip') ||
      t.includes('pistol buffer') || t.includes('pistol caliber'))                          return 'ar-parts';
  // Broad firearm terms last — only reached if no specific category matched above
  if (t.includes('rifle') || t.includes('shotgun'))                                         return 'rifles';
  if (t.includes('handgun') || t.includes('pistol') || t.includes('revolver'))              return 'handguns';
  return 'other';
}

function isRelevant(item) {
  // Must be in stock — exclude clearance, discontinued, and unavailable items
  if (item.StockAvailability !== 'InStock') return false;
  // Must have an image
  const img = item.ImageUrl || (item.AdditionalImageUrls && item.AdditionalImageUrls[0]) || '';
  if (!img) return false;
  // Must not be apparel/footwear/etc. by name
  const name = (item.Name || '').toLowerCase();
  if (NAME_EXCLUDE_KEYWORDS.some(kw => name.includes(kw))) return false;
  // Must map to a known category (holsters and gun-safes excluded from EuroOptic)
  const cat = mapCategory(item.Category || '', item.Name || '');
  if (cat === 'other' || cat === 'holsters' || cat === 'gun-safes') return false;
  // Must meet price floor and be under the ceiling for this category
  const price = parseFloat(item.CurrentPrice || item.SalePrice || 0);
  if (price < (PRICE_FLOORS[cat] || 0)) return false;
  if (PRICE_CEILINGS[cat] && price > PRICE_CEILINGS[cat]) return false;
  // Must be a major brand for this category
  const brand = item.Manufacturer || item.BrandName || item.Brand || '';
  if (!isMajorBrand(brand, cat)) return false;
  return true;
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
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000); // 2-minute timeout
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
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

// Try to advance to the next page when a page is skipped.
// Impact.com uses URLs like: /Mediapartners/XXX/Catalogs/YYY/Items?PageSize=1000&Page=58
// or offset-style: ?PageSize=1000&Offset=57000
function tryAdvancePage(url, currentPageNum) {
  // Page-number style: ?Page=N or &Page=N
  const pageMatch = url.match(/([?&]Page=)(\d+)/i);
  if (pageMatch) {
    return url.replace(/([?&]Page=)\d+/i, `${pageMatch[1]}${currentPageNum + 1}`);
  }
  // Offset style: ?Offset=N or &Offset=N
  const offsetMatch = url.match(/([?&]Offset=)(\d+)/i);
  if (offsetMatch) {
    const newOffset = parseInt(offsetMatch[2]) + 1000;
    return url.replace(/([?&]Offset=)\d+/i, `${offsetMatch[1]}${newOffset}`);
  }
  return null; // cursor-based pagination — cannot reconstruct next URL
}

// Escalating backoff for network errors/timeouts: 5s, 10s, 20s, 30s, 30s, …
function netRetryWait(attempt) {
  const steps = [5000, 10000, 20000, 30000, 30000, 30000];
  return steps[Math.min(attempt - 1, steps.length - 1)];
}

async function fetchViaItems() {
  console.log('--- Strategy 2: Paginated Items ---');
  const PAGE_SIZE      = 1000;  // 1 000 items per page
  const DELAY_MS       = 1000;  // 1 s between successful pages
  const BATCH_SIZE     = 20;    // pause every 20 pages
  const BATCH_PAUSE_MS = 5000;  // 5 s batch pause
  const MAX_RETRIES    = 6;     // max retries for network errors (reduced: 6×backoff ≈ 2 min/page max)
  const MAX_401_RETRIES = 2;    // 401 = likely expired/invalid credentials; fail fast
  const WAIT_401_MS    = 15000; // 15 s wait between 401 retries (3 tries × 15s = 45s max)
  const FETCH_TIMEOUT  = 45000; // 45 s per request (reduced from 90 s — fail fast, retry sooner)
  const TIME_BUDGET_MS = 55 * 60 * 1000; // 55 min hard ceiling — exit gracefully before 90-min Actions kill
  const startTime      = Date.now();

  let allItems = [];
  let pageNum  = 1;
  let nextUrl  = `${ITEMS_URL}?PageSize=${PAGE_SIZE}`;
  let retries  = 0;

  while (nextUrl) {
    const elapsed = Date.now() - startTime;
    if (elapsed > TIME_BUDGET_MS) {
      console.warn(`  [Time budget] 55 min reached on page ${pageNum} (${allItems.length} raw items) — stopping pagination to write partial results.`);
      break;
    }

    if (pageNum > 1 && (pageNum - 1) % BATCH_SIZE === 0) {
      console.log(`  [Batch pause] Waiting ${BATCH_PAUSE_MS / 1000}s...`);
      await sleep(BATCH_PAUSE_MS);
    }

    console.log(`Fetching page ${pageNum}...`);
    let data;
    let retried   = false;
    let skipPage  = false;

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
        const is401   = err.message.startsWith('401');
        const isAbort = err.name === 'AbortError';
        const isNet   = isAbort ||
                        err.message.includes('fetch failed') ||
                        err.message.includes('ECONNRESET') ||
                        err.message.includes('ETIMEDOUT') ||
                        err.message.includes('ENOTFOUND');

        if (is401) {
          // 401 Unauthorized — likely expired/invalid credentials, not a transient rate limit.
          // Fail fast: 2 retries at 15s each. If still 401, credentials need attention.
          if (retries < MAX_401_RETRIES) {
            retries++;
            console.warn(`  401 Unauthorized (attempt ${retries}/${MAX_401_RETRIES}) — waiting ${WAIT_401_MS / 1000}s. Check IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN secrets if this persists.`);
            await sleep(WAIT_401_MS);
            retried = true;
          } else {
            console.error(`  401 Unauthorized after ${MAX_401_RETRIES} retries — credentials appear invalid or expired. Aborting.`);
            throw err;
          }
        } else if (isNet && retries < MAX_RETRIES) {
          retries++;
          const waitMs = netRetryWait(retries);
          const reason = isAbort ? 'timeout' : 'network error';
          console.warn(`  ${reason} (retry ${retries}/${MAX_RETRIES}) — waiting ${waitMs / 1000}s...`);
          await sleep(waitMs);
          retried = true;
        } else {
          // Retries exhausted — always try to skip to the next page first
          const skippedUrl = tryAdvancePage(nextUrl, pageNum);
          if (skippedUrl) {
            console.warn(`  Retries exhausted on page ${pageNum} — skipping to next page (${allItems.length} items so far).`);
            nextUrl  = skippedUrl;
            retries  = 0;
            skipPage = true;
            break;
          }
          // Cursor-based pagination — cannot reconstruct next URL, return what we have
          console.warn(`  Retries exhausted on page ${pageNum} with ${allItems.length} raw items — returning partial results.`);
          return allItems;
        }
      }
    }

    if (skipPage) { pageNum++; continue; }

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
    // 401 from Files = credentials are bad; don't waste time retrying via Items
    if (err.message.includes('401')) {
      console.error(`FATAL: Impact.com API returned 401 Unauthorized on the Files endpoint.`);
      console.error(`Check that IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN, and IMPACT_CATALOG_ID`);
      console.error(`GitHub secrets are correct and have not expired.`);
      process.exit(1);
    }
    console.warn(`Files strategy failed: ${err.message}`);
  }

  // Fall back to paginated Items if Files didn't work
  if (!rawItems || rawItems.length === 0) {
    console.log('\nFalling back to paginated Items strategy...\n');
    rawItems = await fetchViaItems();
  }

  if (!rawItems || rawItems.length === 0) {
    console.warn('WARNING: No products retrieved from either strategy — Impact.com API appears unavailable.');
    console.warn('Existing catalog files are unchanged. Will retry tomorrow.');
    fs.writeFileSync(path.join(dataDir, 'eurooptic-last-run.json'), JSON.stringify({
      lastRun: new Date().toISOString(), status: 'api_unavailable', productCount: 0, rawCount: 0
    }));
    process.exit(0);  // Don't fail the workflow — external API issue, not a code bug
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
    if (rawItems.length < 5000) {
      // API returned very few items — likely a transient outage, not a filtering bug
      console.warn(`WARNING: Only ${allProducts.length} relevant products from ${rawItems.length} raw items.`);
      console.warn('Looks like an API outage rather than a filtering bug — keeping existing catalog.');
      fs.writeFileSync(path.join(dataDir, 'eurooptic-last-run.json'), JSON.stringify({
        lastRun: new Date().toISOString(), status: 'api_partial', productCount: allProducts.length, rawCount: rawItems.length
      }));
      process.exit(0);  // External issue — don't fail the workflow
    }
    // Large raw count but few relevant products = likely a real filtering bug
    console.error(`QUALITY GATE FAILED: Only ${allProducts.length} relevant products from ${rawItems.length} raw items — check filtering logic.`);
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

  // Priority brands for rifles: popular hunting/sporting manufacturers that people
  // actually search for and buy. These are sorted price-ASCENDING (most affordable
  // first) so a $499 Ruger American ranks above a $2,800 custom build.
  // Ultra-premium ($3,000+) are already excluded by PRICE_CEILINGS above.
  const PRIORITY_BRANDS = {
    rifles: ['ruger','tikka','weatherby','cva','browning','remington','winchester',
             'bergara','cz','savage','mossberg','henry','howa','rossi','traditions',
             'christensen','fn','sig sauer','springfield','daniel defense']
  };

  // Apply per-category caps:
  //   • Priority brands → sorted price ASC (affordable + popular first)
  //   • Remaining brands → sorted price ASC (fill remaining slots, still affordable-first)
  for (const cat of Object.keys(byCategory)) {
    const cap = CAT_CAPS[cat];
    if (!cap || byCategory[cat].length <= cap) continue;

    const priorityBrands = PRIORITY_BRANDS[cat] || [];
    if (priorityBrands.length) {
      const isPriority = p => priorityBrands.some(br => (p.brand || '').toLowerCase().includes(br));
      const priority = byCategory[cat].filter(isPriority).sort((a, b) => a.price - b.price);  // asc
      const rest     = byCategory[cat].filter(p => !isPriority(p)).sort((a, b) => a.price - b.price); // asc
      const before   = priority.length + rest.length;
      byCategory[cat] = [...priority, ...rest].slice(0, cap);
      console.log(`  [cap] ${cat}: ${before} → ${cap} (${priority.length} priority-brand affordable-first, ${byCategory[cat].length - priority.length} other fill)`);
    } else {
      byCategory[cat].sort((a, b) => b.price - a.price);
      console.log(`  [cap] ${cat}: ${byCategory[cat].length} → ${cap}`);
      byCategory[cat] = byCategory[cat].slice(0, cap);
    }
  }

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
