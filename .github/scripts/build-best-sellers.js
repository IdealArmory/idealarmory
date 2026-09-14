// build-best-sellers.js
// Builds data/best-sellers.json: a live, cross-retailer-merged product pool for
// the homepage "Best Sellers" carousel. Replaces a 106-item array that was
// hardcoded directly into index.html (Ideal Armory's original pre-integration
// seed catalog), with single hardcoded sellers/prices frozen since the site's
// early days and fabricated review/star counts that were never rendered
// anywhere anyway.
//
// Real popularity signal used here: a product carried by multiple retailers
// (UPC-matched, same logic the category pages already use client-side) is
// genuine evidence of a popular, in-demand item — not a guess. Those are
// ranked first; single-retailer listings from known/popular brands fill the
// rest of each category's quota.
//
// Rebuilt automatically by the existing "Build Search Index" workflow, which
// already runs after every retailer refresh.
// Run: node .github/scripts/build-best-sellers.js

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const OUT_FILE = path.join(DATA_DIR, 'best-sellers.json');

const SRC_DISPLAY = {
  eurooptic:  'EuroOptic',
  bereli:     'Bereli',
  impactguns: 'Impact Guns',
  gunscom:    'Guns.com',
  cyasupply:  'CYA Supply Co.',
  luckygunner:'Lucky Gunner',
};

// Short category codes (matches the carousel's existing filter-chip scheme)
// mapped to the retailer data files that feed each one. "accessory" combines
// magazines/ar-parts/cleaning into one broader bucket, same as the old data's
// largest category.
const CATEGORY_GROUPS = {
  handgun:   { cat: 'handguns',   floor: 300, files: ['eurooptic-handguns.json','bereli-handguns.json','impactguns-handguns.json','gunscom-handguns.json'] },
  rifle:     { cat: 'rifles',     floor: 300, files: ['eurooptic-rifles.json','bereli-rifles.json','impactguns-rifles.json','gunscom-rifles.json'] },
  shotgun:   { cat: 'shotguns',   floor: 250, files: ['impactguns-shotguns.json','gunscom-shotguns.json'] },
  ammo:      { cat: 'ammunition', floor: 15,  files: ['eurooptic-ammunition.json','bereli-ammunition.json','impactguns-ammunition.json','gunscom-ammunition.json','luckygunner-ammunition.json'] },
  optic:     { cat: 'optics',     floor: 50,  files: ['eurooptic-optics.json','bereli-optics.json','impactguns-optics.json','gunscom-optics.json'] },
  holster:   { cat: 'holsters',   floor: 20,  files: ['eurooptic-holsters.json','impactguns-holsters.json','gunscom-holsters.json','cyasupply-holsters.json'] },
  accessory: { cat: 'accessory',  floor: 15,  files: ['eurooptic-magazines.json','bereli-magazines.json','impactguns-magazines.json','gunscom-magazines.json','cyasupply-magazines.json',
                                                        'eurooptic-ar-parts.json','bereli-ar-parts.json','gunscom-ar-parts.json',
                                                        'eurooptic-cleaning.json','bereli-cleaning.json','impactguns-cleaning.json','gunscom-cleaning.json','cyasupply-cleaning.json'] },
};

// Popular manufacturers — same philosophy as the retailer fetch scripts'
// priority-brand lists, broadened to cover accessory/optics brands too.
const PRIORITY_BRANDS = [
  'glock','sig sauer','smith & wesson','ruger','springfield','taurus','beretta',
  'canik','walther','cz','tikka','weatherby','cva','browning','remington',
  'winchester','bergara','savage','mossberg','henry','christensen','fn',
  'daniel defense','benelli','colt','kimber','h&k','heckler','iwi',
  'federal','hornady','cci','speer','magpul','vortex','leupold','trijicon',
  'eotech','aimpoint','holosun','burris','nightforce','alien gear','safariland',
  'galco','desantis','blackhawk',
];

const POOL_TARGET_PER_CAT = 120; // enough for months of daily rotation variety

function isPriorityBrand(brand) {
  const b = (brand || '').toLowerCase();
  return PRIORITY_BRANDS.some(k => b.includes(k));
}

function loadFeed(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    return []; // file may not exist for every retailer/category combo — fine
  }
}

let nextId = 1;
const pool = [];

for (const [shortCat, group] of Object.entries(CATEGORY_GROUPS)) {
  // 1. Load every retailer file for this category group and index by UPC.
  const byUpc = new Map();   // upc -> { item, sellers: [{name, price, stock, url}] }
  const noUpc = [];          // items without a UPC — kept as single-seller entries

  for (const file of group.files) {
    const src = file.split('-')[0];
    const via = SRC_DISPLAY[src] || src;
    for (const raw of loadFeed(file)) {
      const price = parseFloat(raw.price) || 0;
      if (price < group.floor) continue;
      if (raw.inStock === false) continue;
      if (!raw.img || !raw.url || !raw.name || !raw.brand) continue;

      const seller = { name: via, price, stock: raw.inStock === false ? 'out' : 'in', url: raw.url };

      if (raw.upc) {
        if (!byUpc.has(raw.upc)) {
          byUpc.set(raw.upc, { brand: raw.brand, name: raw.name, sub: raw.sub || raw.caliber || '', img: raw.img, sellers: [] });
        }
        const entry = byUpc.get(raw.upc);
        if (!entry.sellers.some(s => s.name === via)) entry.sellers.push(seller);
      } else {
        noUpc.push({ brand: raw.brand, name: raw.name, sub: raw.sub || raw.caliber || '', img: raw.img, sellers: [seller] });
      }
    }
  }

  // 2. Cross-retailer matches (2+ sellers) are the strongest real popularity
  //    signal — a product genuinely carried by multiple independent retailers.
  const crossMatched = [...byUpc.values()].filter(p => p.sellers.length > 1);
  const singleUpc     = [...byUpc.values()].filter(p => p.sellers.length === 1);
  const singleOther    = noUpc;

  crossMatched.forEach(p => p.sellers.sort((a, b) => a.price - b.price));

  // 3. Fill the category quota: cross-matched first, then popular-brand
  //    single-seller items, then any remaining single-seller items.
  const priorityPool = [...singleUpc, ...singleOther].filter(p => isPriorityBrand(p.brand));
  const otherPool     = [...singleUpc, ...singleOther].filter(p => !isPriorityBrand(p.brand));

  const chosen = [
    ...crossMatched,
    ...priorityPool,
    ...otherPool,
  ].slice(0, POOL_TARGET_PER_CAT);

  for (const item of chosen) {
    pool.push({
      id: nextId++,
      brand: item.brand,
      name: item.name,
      sub: item.sub,
      img: item.img,
      cat: shortCat,
      sellers: item.sellers,
    });
  }

  console.log(`  ${shortCat}: ${chosen.length} items (${crossMatched.length} cross-matched, ${chosen.length - crossMatched.length} single-seller)`);
}

if (pool.length < 50) {
  console.warn(`WARNING: only ${pool.length} best-seller candidates found — check that retailer data files exist.`);
}

fs.writeFileSync(OUT_FILE, JSON.stringify(pool));
console.log(`Wrote ${OUT_FILE}: ${pool.length} items across ${Object.keys(CATEGORY_GROUPS).length} categories`);
