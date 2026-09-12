// fetch-gunscom.js
// Fetches the Guns.com product feed via AvantLink (direct TSV download, single file,
// no pagination). Writes data/gunscom-<category>.json + data/gunscom-last-run.json.
//
// IMPORTANT — this feed is NOT RFC4180-quoted: the "Long Description" column
// frequently contains raw, unescaped newlines (blank-line paragraphs) AND,
// for listings with pasted spec tables, literal embedded TAB characters.
// Both make naive line/tab splitting unreliable — a fixed-column-count
// reassembly (only resyncing at the last column) still shatters on rows with
// extra embedded tabs, since the column *count* reaches the boundary early.
//
// Instead we anchor on real record starts: every record begins with its SKU
// followed by an identical Manufacturer Id (`\n<digits>\t<digits>\t`, both
// numbers equal — confirmed by inspecting real feed pulls, never a false
// positive). Splitting the file on that pattern gives exact record boundaries
// regardless of what's embedded inside the description. Within a record, if
// splitting on '\t' yields more than 22 fields (extra tabs from a spec table),
// the surplus is folded back into the Long Description field — the only field
// we don't otherwise use. See parseFeed() below.
//
// Buy Link is already a complete AvantLink click-tracking URL — no affiliate
// params need to be appended (unlike the CYA Supply / Impact Guns scrapers).

'use strict';

const fs   = require('fs');
const path = require('path');

const FEED_URL = process.env.GUNSCOM_FEED_URL;

if (!FEED_URL) {
  console.error('ERROR: GUNSCOM_FEED_URL not set. Add it as a GitHub Actions secret.');
  process.exit(1);
}

const NUM_COLS = 22; // SKU..Product Content Widget — header is read from the file itself

// ── Category mapping (Department is a clean, controlled field in this feed) ───
// Silencers / Silencer Accessories excluded: NFA-regulated items (ATF Form 4 +
// tax stamp + SOT-dealer transfer) — a materially different purchase process
// than the rest of the catalog, so left out rather than silently listed.
// Knives And Tools / Range Gear / Hunting Gear / Gear: not current site categories.
const DEPT_MAP = {
  'handguns':              'handguns',
  'rifles':                'rifles',
  'shotguns':               'shotguns',
  'ammo':                   'ammunition',
  'magazines':              'magazines',
  'holsters and holders':   'holsters',
  'optics':                 'optics',
  'gun parts':              'ar-parts',
  'cleaning supplies':      'cleaning',
};

// ── Popular price ranges — what people actually buy, not top-end/collector items ──
const PRICE_FLOORS = {
  handguns: 150, rifles: 200, shotguns: 150, ammunition: 10,
  magazines: 10, holsters: 10, optics: 30, 'ar-parts': 20, cleaning: 5,
};
const PRICE_CEILINGS = {
  handguns: 2000, rifles: 3000, shotguns: 2500, ammunition: 500,
  magazines: 150, holsters: 150, optics: 1500, 'ar-parts': 800, cleaning: 100,
};

// ── Brand whitelist per category — same list/approach as fetch-eurooptic.js, plus
// a shotguns list (EuroOptic doesn't carry shotguns as its own category). Keeps
// this feed limited to brands people actually search for, same as the other feeds.
const BRAND_WHITELIST = {
  handguns: ['glock','sig sauer','sig','smith & wesson','smith and wesson','springfield','ruger','cz','walther','heckler','h&k','taurus','beretta','kimber','daniel defense','canik','fn america','fn herst','shadow systems','kahr','nighthawk','wilson combat','staccato','magnum research','heritage','charter','rock island','kel-tec','keltec','bond arms','diamondback','hi-point','colt'],
  rifles: ['ruger','tikka','weatherby','cva','browning','remington','winchester','bergara','cz','savage','smith & wesson','sig sauer','springfield','daniel defense','cmmg','fn america','fn herst','mossberg','henry','barrett','christensen','howa','stag arms','windham','bushmaster','dpms','armalite','palmetto','psa','lwrc','bcm','bravo company','marlin','rossi','traditions','colt'],
  shotguns: ['mossberg','remington','winchester','benelli','beretta','browning','stevens','cz','savage','weatherby','tristar','franchi','stoeger','charles daly','escort','hatsan','ruger'],
  optics: ['leupold','vortex','nightforce','trijicon','eotech','aimpoint','bushnell','crimson trace','sig sauer','burris','swarovski','primary arms','steiner','holosun','zeiss','maven','tract','schmidt','kahles','march','minox','hawke','nikon','weaver','mepro','meprolight','atibal','riton','swampfox','athlon','arken'],
  ammunition: ['federal','hornady','winchester','remington','cci','speer','nosler','barnes','pmc','magtech','fiocchi','wolf','sellier','blazer','american eagle','corbon','buffalo bore','liberty','black hills','aguila','nato','prvi','tulammo'],
  holsters: ['alien gear','blackhawk','safariland','galco','desantis','crossbreed','bianchi','uncle','vedder','we the people','blackpoint','fobus','serpa','tulster','tier 1','t1c','hidden hybrid','cloak','bravo concealment','concealment express','rounded','gun daddy','mod 1','1791','craft holsters','tagua'],
  'ar-parts': ['magpul','bcm','bravo company','aero precision','daniel defense','geissele','larue','yhm','yankee hill','noveske','spike','wilson combat','alg','fortis','surefire','silencerco','kac','knight','lwrc','midwest industries','phase 5','cmmg','seekins','rise armament'],
  magazines: ['magpul','ets','promag','lancer','hexmag','kci','glock','beretta','fn','sig','cz'],
  cleaning: ["hoppe's",'hoppes','break-free','otis','bore snake','tipton','real avid','sentry','ballistol','mpro','m-pro','tetra','slip 2000','clenzoil','wipe-out','shooter','froglube','hornady'],
};

// Priority brands sort first within a capped category (still cheapest-first within
// that group) — mirrors fetch-eurooptic.js's rifle handling, extended to other cats
// where Guns.com's inventory skews toward brands people don't search for as often.
const PRIORITY_BRANDS = {
  rifles: ['ruger','tikka','weatherby','cva','browning','remington','winchester','bergara','cz','savage','mossberg','henry','howa','rossi','traditions','christensen','fn','sig sauer','springfield','daniel defense'],
  handguns: ['glock','sig sauer','smith & wesson','ruger','springfield','taurus','beretta','canik','walther','cz'],
  shotguns: ['mossberg','remington','winchester','benelli','beretta','browning','savage'],
};

function isMajorBrand(brand, cat) {
  const b = (brand || '').toLowerCase();
  if (!b) return false;
  const list = BRAND_WHITELIST[cat] || [];
  return list.some(kw => b.includes(kw));
}

const CAT_CAPS = {
  handguns: 700, rifles: 900, shotguns: 400, ammunition: 300,
  magazines: 250, holsters: 150, optics: 200, 'ar-parts': 100, cleaning: 60,
};

function mapCategory(department) {
  return DEPT_MAP[(department || '').trim().toLowerCase()] || null;
}

// ── Feed parser ─────────────────────────────────────────────────────────────
// Anchors on `\n<digits>\t<digits>\t` where both numbers match (SKU === Manufacturer
// Id at the start of every real record) to find true record boundaries, then
// tolerates any number of extra embedded tabs within a record by folding the
// surplus back into the Long Description field.
const RECORD_START = /\n(\d+)\t\1\t/g;

function parseFeed(text) {
  const boundaries = [];
  let m;
  RECORD_START.lastIndex = 0;
  while ((m = RECORD_START.exec(text)) !== null) {
    boundaries.push(m.index + 1); // position right after the '\n'
  }
  if (!boundaries.length) return [];

  const header = text.slice(0, boundaries[0]).replace(/\r?\n$/, '').split('\t');
  const records = [];

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : text.length;
    const fields = text.slice(start, end).replace(/\r?\n$/, '').split('\t');

    let row;
    if (fields.length === NUM_COLS) {
      row = fields;
    } else if (fields.length > NUM_COLS) {
      // Extra tabs (e.g. a pasted spec table) landed inside Long Description —
      // fold everything between the first 4 and the last 17 fields back together.
      const first4 = fields.slice(0, 4);
      const tail17 = fields.slice(-17);
      const desc = fields.slice(4, fields.length - 17).join('\t');
      row = [...first4, desc, ...tail17];
    } else {
      continue; // shorter than expected — truncated/corrupt record, drop it
    }

    const obj = {};
    header.forEach((h, idx) => { obj[h] = row[idx] || ''; });
    records.push(obj);
  }

  return records;
}

function isRelevant(item, cat) {
  if (!cat) return false;
  const name = (item['Product Name'] || '').trim();
  if (!name) return false;
  const brand = (item['Brand Name'] || '').trim();
  if (!brand) return false;
  const img = item['Image URL'] || item['Thumb URL'] || '';
  if (!img) return false;
  const price = parseFloat(item['Sale Price'] || item['Retail Price'] || 0);
  if (!(price >= (PRICE_FLOORS[cat] || 0) && price <= (PRICE_CEILINGS[cat] || Infinity))) return false;
  if (!isMajorBrand(brand, cat)) return false;
  return true;
}

function transformProduct(item, cat) {
  const price = parseFloat(item['Sale Price'] || item['Retail Price'] || 0);
  const orig  = parseFloat(item['Retail Price'] || item['Sale Price'] || 0);
  return {
    id:      'gc_' + (item['SKU'] || item['Manufacturer Id'] || ''),
    upc:     (item['UPC'] || '').trim(),
    brand:   item['Brand Name'].trim(),
    name:    item['Product Name'].trim(),
    price,
    orig:    orig || price,
    img:     item['Image URL'] || item['Thumb URL'] || '',
    url:     item['Buy Link'] || '',
    category: cat,
    inStock: true,   // AvantLink pull feed — unavailable items are dropped upstream, not flagged
    src: 'gunscom',
  };
}

async function downloadText(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5 * 60 * 1000); // 5-minute timeout — feed is 40MB+
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

async function main() {
  console.log('=== Guns.com Catalog Fetch (AvantLink) ===');
  console.log(`Started: ${new Date().toISOString()}\n`);

  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  let text;
  try {
    text = await downloadText(FEED_URL);
  } catch (err) {
    console.warn(`WARNING: Feed download failed: ${err.message}`);
    console.warn('Existing catalog files are unchanged. Will retry tomorrow.');
    fs.writeFileSync(path.join(dataDir, 'gunscom-last-run.json'), JSON.stringify({
      lastRun: new Date().toISOString(), status: 'download_failed', productCount: 0, rawCount: 0
    }));
    process.exit(0); // external issue, not a code bug — don't fail the workflow
  }
  console.log(`Downloaded ${text.length.toLocaleString()} characters.`);

  const rawItems = parseFeed(text);
  console.log(`Parsed ${rawItems.length.toLocaleString()} raw rows.`);

  if (rawItems.length < 5000) {
    console.warn(`WARNING: Only ${rawItems.length} raw rows — looks like an upstream outage, not a parsing bug.`);
    console.warn('Keeping existing catalog unchanged.');
    fs.writeFileSync(path.join(dataDir, 'gunscom-last-run.json'), JSON.stringify({
      lastRun: new Date().toISOString(), status: 'feed_too_small', productCount: 0, rawCount: rawItems.length
    }));
    process.exit(0);
  }

  const byCategory = {};
  const deptCounts = {};
  rawItems.forEach(item => {
    const dept = (item['Department'] || '').trim();
    deptCounts[dept] = (deptCounts[dept] || 0) + 1;
    const cat = mapCategory(dept);
    if (!isRelevant(item, cat)) return;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(transformProduct(item, cat));
  });

  console.log('\nDepartment breakdown (raw):');
  Object.entries(deptCounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k || '(blank)'}: ${v}`));

  const totalRelevant = Object.values(byCategory).reduce((n, arr) => n + arr.length, 0);
  if (totalRelevant === 0) {
    console.warn('WARNING: 0 relevant products — likely a field-name or parsing mismatch. Keeping existing catalog.');
    fs.writeFileSync(path.join(dataDir, 'gunscom-last-run.json'), JSON.stringify({
      lastRun: new Date().toISOString(), status: 'field_mismatch', productCount: 0, rawCount: rawItems.length
    }));
    process.exit(0);
  }

  // Apply per-category caps: priority (well-known, popular) brands fill first,
  // both groups sorted cheapest-first — same approach as fetch-eurooptic.js.
  for (const cat of Object.keys(byCategory)) {
    const cap = CAT_CAPS[cat];
    if (!cap || byCategory[cat].length <= cap) {
      byCategory[cat].sort((a, b) => a.price - b.price);
      continue;
    }
    const priorityBrands = PRIORITY_BRANDS[cat] || [];
    if (priorityBrands.length) {
      const isPriority = p => priorityBrands.some(br => (p.brand || '').toLowerCase().includes(br));
      const priority = byCategory[cat].filter(isPriority).sort((a, b) => a.price - b.price);
      const rest     = byCategory[cat].filter(p => !isPriority(p)).sort((a, b) => a.price - b.price);
      const before   = priority.length + rest.length;
      byCategory[cat] = [...priority, ...rest].slice(0, cap);
      console.log(`  [cap] ${cat}: ${before} → ${cap} (${priority.length} priority-brand, ${byCategory[cat].length - priority.length} other fill)`);
    } else {
      byCategory[cat].sort((a, b) => a.price - b.price);
      console.log(`  [cap] ${cat}: ${byCategory[cat].length} → ${cap}`);
      byCategory[cat] = byCategory[cat].slice(0, cap);
    }
  }

  const filesWritten = [];
  const catCounts = {};
  for (const [cat, products] of Object.entries(byCategory)) {
    const fname = `gunscom-${cat}.json`;
    fs.writeFileSync(path.join(dataDir, fname), JSON.stringify(products));
    const kb = Math.round(fs.statSync(path.join(dataDir, fname)).size / 1024);
    console.log(`  ${fname}: ${products.length} products (${kb} KB)`);
    filesWritten.push(fname);
    catCounts[cat] = products.length;
  }

  fs.writeFileSync(path.join(dataDir, 'gunscom-last-run.json'), JSON.stringify({
    lastRun: new Date().toISOString(),
    productCount: totalRelevant,
    rawCount: rawItems.length,
    categories: catCounts,
    files: filesWritten,
    status: 'success'
  }));

  console.log(`\nSUCCESS: ${totalRelevant} relevant products written across ${filesWritten.length} category files.`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
