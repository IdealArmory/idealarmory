// build-deals.js
// Builds data/deal-of-the-day.json: a rotating pool of real, live discounted
// firearms pulled from the retailer feeds, ranked by discount % among popular
// manufacturers. Replaces the old static 33-item hardcoded DOTD_POOL that used
// to live in index.html — that pool never changed and had stale, hand-typed
// prices. This one is rebuilt every time any retailer feed refreshes (the
// existing "Build Search Index" workflow already runs after each one), so the
// Deal of the Day pool — and the prices in it — actually stay current, and at
// ~200+ items it won't visibly repeat for months instead of every ~33 days.
// Run: node .github/scripts/build-deals.js

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const OUT_FILE = path.join(DATA_DIR, 'deal-of-the-day.json');

const SRC_DISPLAY = {
  eurooptic:  'EuroOptic',
  bereli:     'Bereli',
  impactguns: 'Impact Guns',
  gunscom:    'Guns.com',
};

// Firearm categories only — Deal of the Day is the homepage's headline
// promotional slot, matching what the old static pool always featured.
const FEEDS = [
  { src: 'eurooptic',  cat: 'handguns', file: 'eurooptic-handguns.json'  },
  { src: 'eurooptic',  cat: 'rifles',   file: 'eurooptic-rifles.json'    },
  { src: 'bereli',     cat: 'handguns', file: 'bereli-handguns.json'     },
  { src: 'bereli',     cat: 'rifles',   file: 'bereli-rifles.json'       },
  { src: 'impactguns', cat: 'handguns', file: 'impactguns-handguns.json' },
  { src: 'impactguns', cat: 'rifles',   file: 'impactguns-rifles.json'   },
  { src: 'impactguns', cat: 'shotguns', file: 'impactguns-shotguns.json' },
  { src: 'gunscom',    cat: 'handguns', file: 'gunscom-handguns.json'    },
  { src: 'gunscom',    cat: 'rifles',   file: 'gunscom-rifles.json'      },
  { src: 'gunscom',    cat: 'shotguns', file: 'gunscom-shotguns.json'    },
];

// Popular manufacturers worth featuring as a homepage hero deal — same
// priority-brand philosophy already used in the retailer fetch scripts.
const PRIORITY_BRANDS = [
  'glock','sig sauer','smith & wesson','ruger','springfield','taurus','beretta',
  'canik','walther','cz','tikka','weatherby','cva','browning','remington',
  'winchester','bergara','savage','mossberg','henry','christensen','fn',
  'daniel defense','benelli','colt','kimber','h&k','heckler','iwi',
];

const MIN_PRICE        = 300; // matches the site's "popular price range" floor elsewhere
const MIN_DISCOUNT_PCT = 8;   // must be a genuine discount, not rounding noise
const MAX_DISCOUNT_PCT = 45;  // filters out data-entry errors / odd clearance outliers
const POOL_SIZE        = 250; // rotates ~8 months before any repeat, vs. ~33 days before

function isPriorityBrand(brand) {
  const b = (brand || '').toLowerCase();
  return PRIORITY_BRANDS.some(k => b.includes(k));
}

function loadFeed(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    return []; // retailer file may not exist yet on a fresh checkout — fine
  }
}

const candidates = [];
for (const feed of FEEDS) {
  for (const raw of loadFeed(feed.file)) {
    const price = parseFloat(raw.price) || 0;
    const orig  = parseFloat(raw.orig)  || price;
    if (price < MIN_PRICE) continue;
    if (raw.inStock === false) continue;
    if (!raw.img || !raw.url || !raw.name || !raw.brand) continue;
    if (!isPriorityBrand(raw.brand)) continue;
    const pct = orig > price ? (orig - price) / orig * 100 : 0;
    if (pct < MIN_DISCOUNT_PCT || pct > MAX_DISCOUNT_PCT) continue;
    candidates.push({
      brand: raw.brand,
      name:  raw.name,
      sub:   raw.sub || raw.caliber || '',
      img:   raw.img,
      price, orig,
      url:      raw.url,
      via:      SRC_DISPLAY[feed.src] || feed.src,
      category: feed.cat,
    });
  }
}

// Biggest genuine discount first.
candidates.sort((a, b) => (b.orig - b.price) / b.orig - (a.orig - a.price) / a.orig);

// De-dupe by brand+name so the pool isn't dominated by one product line's
// many caliber/finish variants, then cap to POOL_SIZE.
const seen = new Set();
const pool = [];
for (const c of candidates) {
  const key = (c.brand + '|' + c.name).toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  pool.push(c);
  if (pool.length >= POOL_SIZE) break;
}

if (pool.length < 20) {
  console.warn(`WARNING: only ${pool.length} deal candidates found — check that retailer data files exist.`);
}

fs.writeFileSync(OUT_FILE, JSON.stringify(pool));
console.log(`Wrote ${OUT_FILE}: ${pool.length} deals (from ${candidates.length} candidates before de-dupe)`);
