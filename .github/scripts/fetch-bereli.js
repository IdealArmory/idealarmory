// fetch-bereli.js
// Fetches Bereli.com product catalog from the AmmoFeeds XML data feed.
// No API credentials needed — feed is publicly accessible.
// Writes data/bereli-{category}.json + data/bereli-last-run.json
//
// Feed URL: http://www.ammofeeds.com/datafeed/bereli/slickguns/N999gB.xml
// XML structure:
//   <productlist retailer="bereli.com">
//     <product type="Ammunition">
//       <id><![CDATA[446268-8934462]]></id>
//       <manufacturer><![CDATA[Speer]]></manufacturer>
//       <title><![CDATA[...]]></title>
//       <url><![CDATA[https://bereli.com/...]]></url>
//       <image><![CDATA[https://...]]></image>
//       <price><![CDATA[69.00]]></price>
//       <caliber><![CDATA[9mm Luger]]></caliber>
//       <upc><![CDATA[076683536195]]></upc>
//       <mpn><![CDATA[53619]]></mpn>
//       <numrounds><![CDATA[100]]></numrounds>
//       <qty_available><![CDATA[207]]></qty_available>
//     </product>
//   </productlist>

const fs   = require('fs');
const path = require('path');

const FEED_URL = 'http://www.ammofeeds.com/datafeed/bereli/slickguns/N999gB.xml';
const AFF_TAG  = '?aff=10388';

// ── Types to skip entirely ────────────────────────────────────────────────────
const SKIP_TYPES = new Set([
  'Air Guns','Knives','Defense','Apparel','Tools',
  'Survival','Safety','Fishing','Camping'
]);

// ── Brand whitelist (mirrors fetch-eurooptic.js) ──────────────────────────────
const BRAND_WHITELIST = {
  'handguns':   ['glock','sig sauer','sig','smith & wesson','smith and wesson',
                 'springfield','ruger','cz','walther','heckler','h&k','taurus',
                 'beretta','kimber','daniel defense','canik','fn america',
                 'shadow systems','kahr','nighthawk','wilson combat','staccato',
                 'magnum research','heritage','charter','rock island','kel-tec'],
  'rifles':     ['ruger','smith & wesson','sig sauer','springfield','daniel defense',
                 'cmmg','fn america','savage','mossberg','remington','winchester',
                 'henry','browning','tikka','bergara','barrett','christensen',
                 'stag arms','windham','bushmaster','dpms','palmetto','psa',
                 'lwrc','bcm','bravo company'],
  'optics':     ['leupold','vortex','nightforce','trijicon','eotech','aimpoint',
                 'bushnell','crimson trace','sig sauer','burris','swarovski',
                 'primary arms','steiner','holosun','zeiss','maven','tract',
                 'riton','swampfox','athlon','arken'],
  'ammunition': ['federal','hornady','winchester','remington','cci','speer',
                 'nosler','barnes','pmc','magtech','fiocchi','wolf','sellier',
                 'blazer','american eagle','corbon','buffalo bore','liberty',
                 'black hills','aguila','prvi','tulammo'],
  'ar-parts':   ['magpul','bcm','bravo company','aero precision','daniel defense',
                 'geissele','larue','yhm','yankee hill','noveske','spike',
                 'wilson combat','alg','fortis','surefire','silencerco','kac',
                 'knight','lwrc','midwest industries','phase 5','cmmg',
                 'seekins','rise armament'],
  'magazines':  ['magpul','ets','promag','lancer','hexmag','kci','glock',
                 'beretta','fn','sig','cz'],
  'cleaning':   ["hoppe's",'hoppes','break-free','otis','bore snake','tipton',
                 'real avid','sentry','ballistol','mpro','m-pro','tetra',
                 'slip 2000','clenzoil','wipe-out','froglube'],
};

// ── Price floors per category ─────────────────────────────────────────────────
const PRICE_FLOORS = {
  'handguns':   300,
  'rifles':     400,
  'optics':     100,
  'ammunition':  15,
  'ar-parts':    20,
  'magazines':   10,
  'cleaning':     5,
};

// ── Per-category product caps (sorted by price desc) ─────────────────────────
const CAT_CAPS = {
  'handguns':   500,
  'rifles':     500,
  'optics':     500,
  'ammunition': 800,
  'ar-parts':   400,
  'magazines':  300,
  'cleaning':   150,
};

// ── Caliber sets for Guns sub-classification ──────────────────────────────────
const RIFLE_CALIBERS = [
  '5.56','223 rem','308','7.62x39','6.5 creedmoor','6.5creedmoor',
  '300 blackout','300blk','.338','338 lapua','30-06','6mm arc',
  '6.5 prc','450 bushmaster','350 legend','45-70','.308'
];
const SHOTGUN_CALIBERS = ['12 gauge','20 gauge','.410','16 gauge'];

// ── Category mapper ───────────────────────────────────────────────────────────
function mapCategory(type, title, caliber) {
  const t = (title   || '').toLowerCase();
  const c = (caliber || '').toLowerCase();

  if (SKIP_TYPES.has(type)) return 'other';

  switch (type) {
    case 'Ammunition':
    case 'Bullets':   return 'ammunition';   // Bullets = reloading components
    case 'Magazines': return 'magazines';
    case 'Optics':    return 'optics';
    case 'Gun Parts': return 'ar-parts';
    case 'Gun Care':  return 'cleaning';
    case 'Shooting':  return 'ar-parts';     // bipods, rests, accessories
    case 'Lights':    return 'ar-parts';     // weapon lights

    case 'Guns': {
      // Use caliber first — most reliable signal
      if (SHOTGUN_CALIBERS.some(s => c.includes(s))) return 'rifles';
      if (RIFLE_CALIBERS.some(s => c.includes(s)))   return 'rifles';
      // Fall back to title keywords
      if (/rifle|carbine|shotgun|ar[\s-]?1[05]|lever[\s-]action/i.test(t)) return 'rifles';
      if (/pistol|handgun|revolver/i.test(t))         return 'handguns';
      // Handgun calibers in title
      if (/9\s?mm|\.45|\.40\s?s&w|\.380|\.357|10\s?mm|\.44/i.test(t + ' ' + c)) return 'handguns';
      return 'handguns'; // sensible default — Bereli is primarily a handgun retailer
    }

    default: return 'other';
  }
}

// ── Brand check ───────────────────────────────────────────────────────────────
function isMajorBrand(brand, category) {
  const b = (brand || '').toLowerCase();
  if (!b) return false;
  const list = BRAND_WHITELIST[category] || [];
  return list.some(kw => b.includes(kw));
}

// ── Affiliate URL builder ─────────────────────────────────────────────────────
function addAffiliate(url) {
  if (!url) return '';
  const base = url.split('?')[0].replace(/\/+$/, '') + '/';
  return base + AFF_TAG;
  // e.g. https://bereli.com/speer-gold-dot-9mm-100rd/?aff=10388
}

// ── XML entity decoder ────────────────────────────────────────────────────────
function decodeXml(str) {
  return (str || '')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g,  "'");
}

// ── XML parser — handles CDATA, no external dependencies ─────────────────────
// Matches every <product type="..."> block then extracts each field by name.
// Supports both <field><![CDATA[value]]></field> and plain <field>value</field>.
function parseBereliFeed(xml) {
  const products  = [];
  const productRe = /<product\s+type="([^"]*)">([\s\S]*?)<\/product>/g;

  let m;
  while ((m = productRe.exec(xml)) !== null) {
    const type  = m[1];
    const block = m[2];

    const get = (name) => {
      // Matches CDATA or plain text inside <name>…</name>
      const re = new RegExp(
        `<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, ''
      );
      const fm = block.match(re);
      return fm ? decodeXml(fm[1].trim()) : '';
    };

    products.push({
      type,
      id:            get('id'),
      manufacturer:  get('manufacturer'),
      title:         get('title'),
      url:           get('url'),
      image:         get('image'),
      price:         parseFloat(get('price'))       || 0,
      caliber:       get('caliber'),
      upc:           get('upc'),
      mpn:           get('mpn'),
      numrounds:     parseInt(get('numrounds'))     || 0,
      qty_available: parseInt(get('qty_available')) || 0,
    });
  }
  return products;
}

// ── Relevance filter ──────────────────────────────────────────────────────────
const NAME_EXCLUDE = [
  'jacket','shirt','pants','boot','shoe','sock','hat cap','glove',
  'backpack','bag','vest','fleece','hoodie','trouser','underwear',
  'balaclava','beanie','apparel','clothing'
];

function isRelevant(p) {
  if (!p.image)            return false;   // must have image
  if (p.price <= 0)        return false;   // must have price
  if (p.qty_available < 1) return false;   // must be in stock
  const n = (p.title + ' ' + p.manufacturer).toLowerCase();
  if (NAME_EXCLUDE.some(kw => n.includes(kw))) return false;
  const cat = mapCategory(p.type, p.title, p.caliber);
  if (cat === 'other') return false;
  if (p.price < (PRICE_FLOORS[cat] || 0)) return false;
  if (!isMajorBrand(p.manufacturer, cat)) return false;
  return true;
}

// ── Product transformer ───────────────────────────────────────────────────────
function transformProduct(p) {
  const category = mapCategory(p.type, p.title, p.caliber);
  return {
    id:        'bereli_' + p.id,
    upc:       p.upc  || '',
    mpn:       p.mpn  || '',
    brand:     p.manufacturer,
    name:      p.title,
    price:     p.price,
    orig:      p.price,
    img:       p.image,
    url:       addAffiliate(p.url),
    category,
    caliber:   p.caliber   || '',
    numrounds: p.numrounds || 0,
    inStock:   p.qty_available > 0,
    src:       'bereli',
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Bereli Catalog Fetch ===');
  console.log(`Feed URL : ${FEED_URL}`);
  console.log(`Started  : ${new Date().toISOString()}\n`);

  // ── Download XML feed ─────────────────────────────────────────────────────
  console.log('Downloading XML feed...');
  let xml;
  try {
    const res = await fetch(FEED_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IdealArmory/1.0; +https://idealarmory.com)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`);
    xml = await res.text();
    console.log(`Downloaded: ${(xml.length / 1024).toFixed(0)} KB`);
  } catch (err) {
    console.error(`Feed download failed: ${err.message}`);
    process.exit(1);
  }

  // ── Parse ─────────────────────────────────────────────────────────────────
  console.log('Parsing XML...');
  const rawItems = parseBereliFeed(xml);
  console.log(`Total products in feed: ${rawItems.length}`);

  if (rawItems.length < 100) {
    console.error(`QUALITY GATE FAILED: Only ${rawItems.length} products parsed — feed may be empty or malformed.`);
    process.exit(1);
  }

  // ── Filter & transform ────────────────────────────────────────────────────
  console.log('\nFiltering to Ideal Armory categories...');
  const allProducts = rawItems.filter(isRelevant).map(transformProduct);

  // Category breakdown
  const catCounts = {};
  allProducts.forEach(p => { catCounts[p.category] = (catCounts[p.category] || 0) + 1; });
  console.log('\nCategory breakdown:');
  Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(`\nTotal relevant products: ${allProducts.length} / ${rawItems.length} raw`);

  if (allProducts.length < 50) {
    console.error(`QUALITY GATE FAILED: Only ${allProducts.length} relevant products after filtering.`);
    process.exit(1);
  }

  // ── Write output files ────────────────────────────────────────────────────
  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Group by category, sort by price desc, apply caps
  const byCategory = {};
  allProducts.forEach(p => {
    if (!byCategory[p.category]) byCategory[p.category] = [];
    byCategory[p.category].push(p);
  });

  const filesWritten = [];
  for (const [cat, products] of Object.entries(byCategory)) {
    products.sort((a, b) => b.price - a.price);
    const cap   = CAT_CAPS[cat];
    const final = cap && products.length > cap ? products.slice(0, cap) : products;
    if (cap && products.length > cap) {
      console.log(`  [cap] ${cat}: ${products.length} → ${cap}`);
    }
    const fname = `bereli-${cat}.json`;
    fs.writeFileSync(path.join(dataDir, fname), JSON.stringify(final));
    const kb = Math.round(fs.statSync(path.join(dataDir, fname)).size / 1024);
    console.log(`  Wrote ${fname}: ${final.length} products (${kb} KB)`);
    filesWritten.push(fname);
  }

  // Write last-run metadata
  fs.writeFileSync(
    path.join(dataDir, 'bereli-last-run.json'),
    JSON.stringify({
      lastRun:      new Date().toISOString(),
      productCount: allProducts.length,
      rawCount:     rawItems.length,
      categories:   catCounts,
      files:        filesWritten,
      status:       'success',
    }, null, 2)
  );

  console.log(`\n========================================`);
  console.log(` SUCCESS`);
  console.log(` ${allProducts.length} products across ${filesWritten.length} categories`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
