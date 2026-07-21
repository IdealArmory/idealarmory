// build-search-index.js
// Merges all affiliate + static product feeds into data/search-index.json
// Run: node .github/scripts/build-search-index.js
// Also called from GitHub Actions after any feed refresh.

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const OUT_FILE = path.join(DATA_DIR, 'search-index.json');

// ── Feed files → {src, category, idPrefix, file} ──────────────────────────────
const FEEDS = [
  // EuroOptic
  { src:'eurooptic',   idPfx:'eo_',      cat:'handguns',   file:'eurooptic-handguns.json'   },
  { src:'eurooptic',   idPfx:'eo_',      cat:'rifles',     file:'eurooptic-rifles.json'     },
  { src:'eurooptic',   idPfx:'eo_',      cat:'ammunition', file:'eurooptic-ammunition.json' },
  { src:'eurooptic',   idPfx:'eo_',      cat:'optics',     file:'eurooptic-optics.json'     },
  { src:'eurooptic',   idPfx:'eo_',      cat:'holsters',   file:'eurooptic-holsters.json'   },
  { src:'eurooptic',   idPfx:'eo_',      cat:'ar-parts',   file:'eurooptic-ar-parts.json'   },
  { src:'eurooptic',   idPfx:'eo_',      cat:'magazines',  file:'eurooptic-magazines.json'  },
  { src:'eurooptic',   idPfx:'eo_',      cat:'cleaning',   file:'eurooptic-cleaning.json'   },
  { src:'eurooptic',   idPfx:'eo_',      cat:'gun-safes',  file:'eurooptic-gun-safes.json'  },
  // Bereli
  { src:'bereli',      idPfx:'bereli_',  cat:'handguns',   file:'bereli-handguns.json'   },
  { src:'bereli',      idPfx:'bereli_',  cat:'rifles',     file:'bereli-rifles.json'     },
  { src:'bereli',      idPfx:'bereli_',  cat:'ammunition', file:'bereli-ammunition.json' },
  { src:'bereli',      idPfx:'bereli_',  cat:'optics',     file:'bereli-optics.json'     },
  { src:'bereli',      idPfx:'bereli_',  cat:'ar-parts',   file:'bereli-ar-parts.json'   },
  { src:'bereli',      idPfx:'bereli_',  cat:'magazines',  file:'bereli-magazines.json'  },
  { src:'bereli',      idPfx:'bereli_',  cat:'cleaning',   file:'bereli-cleaning.json'   },
  // Impact Guns
  { src:'impactguns',  idPfx:'ig_',      cat:'handguns',   file:'impactguns-handguns.json'   },
  { src:'impactguns',  idPfx:'ig_',      cat:'rifles',     file:'impactguns-rifles.json'     },
  { src:'impactguns',  idPfx:'ig_',      cat:'shotguns',   file:'impactguns-shotguns.json'   },
  { src:'impactguns',  idPfx:'ig_',      cat:'ammunition', file:'impactguns-ammunition.json' },
  { src:'impactguns',  idPfx:'ig_',      cat:'optics',     file:'impactguns-optics.json'     },
  { src:'impactguns',  idPfx:'ig_',      cat:'holsters',   file:'impactguns-holsters.json'   },
  { src:'impactguns',  idPfx:'ig_',      cat:'magazines',  file:'impactguns-magazines.json'  },
  { src:'impactguns',  idPfx:'ig_',      cat:'cleaning',   file:'impactguns-cleaning.json'   },
  { src:'impactguns',  idPfx:'ig_',      cat:'gun-safes',  file:'impactguns-gun-safes.json'  },
  // CYA Supply
  { src:'cyasupply',   idPfx:'cya_',     cat:'holsters',   file:'cyasupply-holsters.json'   },
  { src:'cyasupply',   idPfx:'cya_',     cat:'magazines',  file:'cyasupply-magazines.json'  },
  { src:'cyasupply',   idPfx:'cya_',     cat:'cleaning',   file:'cyasupply-cleaning.json'   },
  // Lucky Gunner
  { src:'luckygunner', idPfx:'lg_',      cat:'ammunition', file:'luckygunner-ammunition.json' },
];

// ── Minimum price guard — skip obviously bogus / freebie entries ──────────────
const MIN_PRICE = 1.00;

// ── Normalise one raw product entry into search-index shape ───────────────────
function normalise(raw, feed) {
  if (!raw || typeof raw !== 'object') return null;

  const name  = (raw.name  || '').trim();
  const brand = (raw.brand || '').trim();
  if (!name || !brand) return null;

  const price = parseFloat(raw.price) || 0;
  if (price < MIN_PRICE) return null;

  // Build a clean id — raw id may already carry the prefix (ig_…, cya_…)
  let rawId = String(raw.id || '');
  let id;
  if (rawId.startsWith(feed.idPfx)) {
    id = rawId;                  // already prefixed (Impact Guns, CYA)
  } else if (rawId.startsWith('bereli_')) {
    id = rawId;                  // Bereli already prefixed
  } else {
    id = feed.idPfx + rawId;    // EuroOptic bare numeric ids
  }

  const entry = {
    id,
    name,
    brand,
    category: raw.category || feed.cat,
    src:      feed.src,
    img:      raw.img  || raw.image || null,
    price,
  };

  // Optional enrichment fields (present in some feeds)
  if (raw.sub)     entry.sub     = raw.sub;
  if (raw.caliber) entry.caliber = raw.caliber;
  if (raw.carry)   entry.carry   = raw.carry;

  return entry;
}

// ── Load static + manual products ────────────────────────────────────────────
function loadStaticProducts() {
  const out = [];
  const staticFile = path.join(DATA_DIR, 'static-products.json');
  if (fs.existsSync(staticFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(staticFile, 'utf8'));
      const items = Array.isArray(raw) ? raw : Object.values(raw);
      items.forEach((p, i) => {
        if (!p || !p.name || !p.brand) return;
        out.push({
          id:       p.id || `static_${(p.category||'misc').replace(/[^a-z0-9]/g,'_')}_${i+1}`,
          name:     p.name,
          brand:    p.brand,
          category: p.category || '',
          src:      'static',
          img:      p.img || null,
          price:    parseFloat(p.price) || parseFloat((p.sellers||[{}])[0].price) || 0,
          sub:      p.sub   || undefined,
          caliber:  p.caliber || undefined,
          carry:    p.carry || undefined,
        });
      });
    } catch(e) { console.warn('static-products.json load error:', e.message); }
  }

  const manualFile = path.join(DATA_DIR, 'manual-products.json');
  if (fs.existsSync(manualFile)) {
    try {
      // Handle optional UTF-8 BOM
      const raw = JSON.parse(fs.readFileSync(manualFile, 'utf8').replace(/^﻿/,''));
      const items = Array.isArray(raw) ? raw : Object.values(raw);
      items.forEach((p, i) => {
        if (!p || !p.name || !p.brand) return;
        out.push({
          id:       p.id || `manual_${i+1}`,
          name:     p.name,
          brand:    p.brand,
          category: p.category || '',
          src:      'manual',
          img:      p.img || null,
          price:    parseFloat(p.price) || 0,
          sub:      p.sub   || undefined,
          caliber:  p.caliber || undefined,
        });
      });
    } catch(e) { console.warn('manual-products.json load error:', e.message); }
  }

  return out;
}

// ── Main build ────────────────────────────────────────────────────────────────
function build() {
  const index = [];
  const seen  = new Set();   // deduplicate by id

  // 1. Static / manual first (highest trust, used as tie-breakers)
  const statics = loadStaticProducts();
  statics.forEach(p => {
    if (p.price < MIN_PRICE) return;
    if (seen.has(p.id)) return;
    seen.add(p.id);
    index.push(p);
  });

  // 2. Affiliate feeds
  FEEDS.forEach(feed => {
    const filepath = path.join(DATA_DIR, feed.file);
    if (!fs.existsSync(filepath)) {
      console.warn(`  skip (missing): ${feed.file}`);
      return;
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch(e) {
      console.warn(`  skip (parse error): ${feed.file}:`, e.message);
      return;
    }
    const items = Array.isArray(raw) ? raw : (raw.products || raw.items || []);
    let added = 0;
    items.forEach(p => {
      const entry = normalise(p, feed);
      if (!entry) return;
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      index.push(entry);
      added++;
    });
    console.log(`  ${feed.file}: ${added} products added`);
  });

  // 3. Sort: static/manual first, then by source, then by category, then price asc
  const SRC_ORDER = { static:0, manual:0, eurooptic:1, bereli:2, impactguns:3, cyasupply:4, luckygunner:5 };
  index.sort((a, b) => {
    const so = (SRC_ORDER[a.src]||9) - (SRC_ORDER[b.src]||9);
    if (so !== 0) return so;
    const co = (a.category||'').localeCompare(b.category||'');
    if (co !== 0) return co;
    return (a.price||0) - (b.price||0);
  });

  // 4. Write
  fs.writeFileSync(OUT_FILE, JSON.stringify(index, null, 0) + '\n', 'utf8');
  console.log(`\nWrote ${index.length} products to data/search-index.json`);

  // 5. Summary
  const bySource = {};
  const byCat   = {};
  index.forEach(p => {
    bySource[p.src] = (bySource[p.src]||0)+1;
    byCat[p.category] = (byCat[p.category]||0)+1;
  });
  console.log('By source:', bySource);
  console.log('By category:', byCat);
}

build();
