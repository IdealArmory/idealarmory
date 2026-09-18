// build-sitemap.js
// Rewrites sitemap.xml with:
//   1. <lastmod> dates on every existing static URL (today's date)
//   2. Top product URLs from data/best-sellers.json (priority 0.6, changefreq daily)
//
// Run: node .github/scripts/build-sitemap.js
// Called automatically by the Build Search Index workflow.

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '../..');
const SITEMAP_IN  = path.join(ROOT, 'sitemap.xml');
const SELLERS_IN  = path.join(ROOT, 'data/best-sellers.json');
const MAX_PRODUCTS = 100; // top N best-sellers to include

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// 1. Read and patch the static sitemap — inject <lastmod> on every <url> entry.
let xml = fs.readFileSync(SITEMAP_IN, 'utf8');

// Remove any existing <lastmod> tags so we don't double-insert.
xml = xml.replace(/<lastmod>[^<]*<\/lastmod>\s*/g, '');

// Insert <lastmod>TODAY</lastmod> after each <loc>...</loc>.
xml = xml.replace(/(<loc>[^<]+<\/loc>)/g, `$1<lastmod>${today}</lastmod>`);

// 2. Read best-sellers and build product URL entries.
let productEntries = '';
try {
  const sellers = JSON.parse(fs.readFileSync(SELLERS_IN, 'utf8'));
  const seen    = new Set();
  let   count   = 0;

  for (const item of sellers) {
    if (count >= MAX_PRODUCTS) break;
    const slug = slugify(item.name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    productEntries +=
      `  <url><loc>https://idealarmory.com/product?p=${slug}</loc>` +
      `<lastmod>${today}</lastmod>` +
      `<priority>0.6</priority><changefreq>daily</changefreq></url>\n`;
    count++;
  }

  console.log(`  Added ${count} product URLs to sitemap`);
} catch (e) {
  console.warn(`  Could not load best-sellers.json: ${e.message} — skipping product URLs`);
}

// 3. Splice product entries before the closing </urlset>.
xml = xml.replace('</urlset>', productEntries + '</urlset>');

fs.writeFileSync(SITEMAP_IN, xml, 'utf8');
console.log(`  Wrote sitemap.xml with lastmod=${today} on all entries`);
