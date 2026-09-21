'use strict';

// build-sitemap.js
// Rewrites sitemap.xml with up-to-date <lastmod> on static pages
// and <url> entries for every product page in /products/.
//
// Run: node .github/scripts/build-sitemap.js
// Called by the Build Search Index workflow after product pages are generated.

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '../..');
const PRODUCTS_DIR = path.join(ROOT, 'products');
const SITEMAP_OUT  = path.join(ROOT, 'sitemap.xml');
const today        = new Date().toISOString().slice(0, 10);

// Static pages
const STATIC = [
  { loc: 'https://idealarmory.com/',              priority: '1.0', freq: 'daily'   },
  { loc: 'https://idealarmory.com/handguns',      priority: '0.9', freq: 'daily'   },
  { loc: 'https://idealarmory.com/rifles',        priority: '0.9', freq: 'daily'   },
  { loc: 'https://idealarmory.com/shotguns',      priority: '0.9', freq: 'daily'   },
  { loc: 'https://idealarmory.com/ammunition',    priority: '0.9', freq: 'daily'   },
  { loc: 'https://idealarmory.com/optics',        priority: '0.9', freq: 'daily'   },
  { loc: 'https://idealarmory.com/holsters',      priority: '0.8', freq: 'weekly'  },
  { loc: 'https://idealarmory.com/magazines',     priority: '0.8', freq: 'weekly'  },
  { loc: 'https://idealarmory.com/ar-parts',      priority: '0.8', freq: 'weekly'  },
  { loc: 'https://idealarmory.com/cleaning',      priority: '0.7', freq: 'weekly'  },
  { loc: 'https://idealarmory.com/gun-safes',     priority: '0.7', freq: 'weekly'  },
  { loc: 'https://idealarmory.com/kit',           priority: '0.6', freq: 'weekly'  },
  { loc: 'https://idealarmory.com/ffl-finder',    priority: '0.6', freq: 'monthly' },
  { loc: 'https://idealarmory.com/about',         priority: '0.5', freq: 'monthly' },
  { loc: 'https://idealarmory.com/privacy',       priority: '0.3', freq: 'monthly' },
  { loc: 'https://idealarmory.com/terms',         priority: '0.3', freq: 'monthly' },
];

// Collect all product slugs
const slugs = fs.existsSync(PRODUCTS_DIR)
  ? fs.readdirSync(PRODUCTS_DIR)
      .filter(f => f.endsWith('.html'))
      .map(f => f.slice(0, -5))
      .sort()
  : [];

// Build XML
const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];

for (const p of STATIC) {
  lines.push(`  <url><loc>${p.loc}</loc><lastmod>${today}</lastmod><changefreq>${p.freq}</changefreq><priority>${p.priority}</priority></url>`);
}

for (const slug of slugs) {
  lines.push(`  <url><loc>https://idealarmory.com/products/${slug}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>`);
}

lines.push('</urlset>');

fs.writeFileSync(SITEMAP_OUT, lines.join('\n') + '\n', 'utf8');
console.log(`  Wrote sitemap.xml: ${STATIC.length} static + ${slugs.length} product URLs = ${STATIC.length + slugs.length} total`);
