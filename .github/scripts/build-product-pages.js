'use strict';

// build-product-pages.js
// Reads all retailer catalog JSON files, deduplicates by UPC,
// and writes a static HTML product page for each unique product
// to products/{slug}.html.
//
// Run: node .github/scripts/build-product-pages.js
// Called by the Build Search Index workflow after every catalog refresh.

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '../..');
const DATA_DIR  = path.join(ROOT, 'data');
const OUT_DIR   = path.join(ROOT, 'products');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Config ────────────────────────────────────────────────────────────────────

const CAT_NAMES = {
  handguns: 'Handguns', rifles: 'Rifles', shotguns: 'Shotguns',
  ammunition: 'Ammunition', optics: 'Optics', holsters: 'Holsters',
  magazines: 'Magazines', 'ar-parts': 'AR Parts', cleaning: 'Cleaning',
  'gun-safes': 'Gun Safes',
  // singular variants
  handgun: 'Handguns', rifle: 'Rifles', shotgun: 'Shotguns',
  ammo: 'Ammunition', optic: 'Optics', holster: 'Holsters',
  magazine: 'Magazines', 'ar-part': 'AR Parts', 'gun-safe': 'Gun Safes',
};

const CAT_URLS = {
  handguns: '/handguns', rifles: '/rifles', shotguns: '/shotguns',
  ammunition: '/ammunition', optics: '/optics', holsters: '/holsters',
  magazines: '/magazines', 'ar-parts': '/ar-parts', cleaning: '/cleaning',
  'gun-safes': '/gun-safes',
  handgun: '/handguns', rifle: '/rifles', shotgun: '/shotguns',
  ammo: '/ammunition', optic: '/optics', holster: '/holsters',
  magazine: '/magazines', 'ar-part': '/ar-parts', 'gun-safe': '/gun-safes',
};

const RETAILER_NAMES = {
  eurooptic: 'EuroOptic', impactguns: 'Impact Guns', gunscom: 'Guns.com',
  bereli: 'Bereli', cyasupply: 'CYA Supply', luckygunner: 'Lucky Gunner',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(s) {
  let r = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (r.length > 90) r = r.slice(0, 90).replace(/-+$/, '');
  return r;
}

function he(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmt(n) {
  return (n == null ? 0 : Number(n)).toFixed(2);
}

// ── Phase 1: Load and merge all retailer catalogs ────────────────────────────

const SKIP = /last-run|search-index|deal-of-the-day|best-sellers|static-products|manual-products|ffl/;

const byUpc   = new Map(); // upc -> [product, ...]
const noUpcMap = new Map(); // normalizedName -> merged product

for (const file of fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !SKIP.test(f))) {
  let products;
  try { products = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { continue; }
  if (!Array.isArray(products)) continue;

  for (const p of products) {
    const upc = (p.upc || '').trim();
    if (upc) {
      if (!byUpc.has(upc)) byUpc.set(upc, []);
      byUpc.get(upc).push(p);
    } else {
      const key = (p.name || '').toLowerCase().replace(/\s+/g, ' ');
      if (!key) continue;
      const srcKey = p.src || '';
      const seller = {
        name:  RETAILER_NAMES[srcKey] || srcKey,
        price: p.price,
        stock: p.inStock ? 'in' : 'low',
        url:   p.url || '',
      };
      if (noUpcMap.has(key)) {
        noUpcMap.get(key).sellers.push(seller);
      } else {
        noUpcMap.set(key, {
          upc: '', brand: p.brand || '', name: p.name || '',
          img: p.img || '', cat: p.category || 'other',
          sellers: [seller],
        });
      }
    }
  }
}

// Build unified list
const unified = [];

for (const [, entries] of byUpc) {
  const sorted  = [...entries].sort((a, b) => (a.price || 0) - (b.price || 0));
  const rep     = sorted[0];
  const sellers = sorted.map(p => ({
    name:  RETAILER_NAMES[p.src] || p.src || '',
    price: p.price,
    stock: p.inStock ? 'in' : 'low',
    url:   p.url || '',
  }));
  unified.push({
    upc: '', brand: rep.brand || '', name: rep.name || '',
    img: rep.img || '', cat: rep.category || 'other', sellers,
  });
}

for (const p of noUpcMap.values()) {
  unified.push(p);
}

// ── Phase 2: Generate HTML pages ──────────────────────────────────────────────

const slugSeen = new Set();
let count = 0;

for (const p of unified) {
  let slug = slugify(p.name);
  if (!slug) continue;
  if (slugSeen.has(slug)) slug = `${slug}-${count}`;
  slugSeen.add(slug);

  const sellers  = [...p.sellers].sort((a, b) => (a.price || 0) - (b.price || 0));
  const nSellers = sellers.length;
  const loPrice  = nSellers > 0 ? (sellers[0].price || 0) : 0;
  const hiPrice  = nSellers > 0 ? (sellers[sellers.length - 1].price || 0) : 0;

  const catKey  = p.cat || 'other';
  const catName = CAT_NAMES[catKey] || catKey.charAt(0).toUpperCase() + catKey.slice(1);
  const catUrl  = CAT_URLS[catKey]  || '/';

  const safeName  = he(p.name);
  const safeBrand = he(p.brand);
  const safeImg   = he(p.img);
  const metaDesc  = `Compare ${nSellers} price${nSellers !== 1 ? 's' : ''} on ${p.name}. Best price: $${fmt(loPrice)} from licensed retailers. Free price comparison on Ideal Armory.`;

  const rows = sellers.map(s => {
    const cls  = s.stock === 'in' ? 'in-stock'  : 'check-stock';
    const txt  = s.stock === 'in' ? 'In Stock'  : 'Check';
    return `    <tr><td class="col-seller">${he(s.name)}</td><td class="col-price">$${fmt(s.price)}</td><td><span class="stock ${cls}">${txt}</span></td><td><a href="${he(s.url)}" class="buy-btn" target="_blank" rel="noopener sponsored">View Deal &#8594;</a></td></tr>`;
  }).join('\n');

  const offerArr = sellers.map(s => {
    const avail = s.stock === 'in' ? 'https://schema.org/InStock' : 'https://schema.org/LimitedAvailability';
    const n = (s.name || '').replace(/"/g, '');
    const u = (s.url  || '').replace(/"/g, '');
    return `{"@type":"Offer","seller":{"@type":"Organization","name":"${n}"},"price":"${fmt(s.price)}","priceCurrency":"USD","availability":"${avail}","url":"${u}"}`;
  }).join(',');

  const pName  = (p.name  || '').replace(/"/g, '');
  const pBrand = (p.brand || '').replace(/"/g, '');
  const pImg   = (p.img   || '').replace(/"/g, '');

  const schema = `{"@context":"https://schema.org","@type":"Product","name":"${pName}","brand":{"@type":"Brand","name":"${pBrand}"},"image":"${pImg}","offers":{"@type":"AggregateOffer","lowPrice":"${fmt(loPrice)}","highPrice":"${fmt(hiPrice)}","priceCurrency":"USD","offerCount":"${nSellers}","offers":[${offerArr}]}}`;
  const breadcrumb = `{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://idealarmory.com/"},{"@type":"ListItem","position":2,"name":"${catName}","item":"https://idealarmory.com${catUrl}"},{"@type":"ListItem","position":3,"name":"${pName}","item":"https://idealarmory.com/products/${slug}"}]}`;

  const bestBadge = nSellers > 0
    ? `<div class="best-price">Best price: <strong>$${fmt(loPrice)}</strong> &nbsp;&middot;&nbsp; ${nSellers} ${nSellers === 1 ? 'seller' : 'sellers'}</div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-64.png" sizes="64x64" type="image/png">
<link rel="canonical" href="https://idealarmory.com/products/${slug}">
<title>${safeName} - Price Comparison | Ideal Armory</title>
<meta name="description" content="${he(metaDesc)}">
<meta property="og:type" content="product">
<meta property="og:title" content="${safeName} | Ideal Armory">
<meta property="og:description" content="${he(metaDesc)}">
<meta property="og:image" content="${safeImg}">
<meta property="og:url" content="https://idealarmory.com/products/${slug}">
<meta property="og:site_name" content="Ideal Armory">
<meta name="twitter:card" content="summary_large_image">
<meta name="robots" content="index,follow">
<script type="application/ld+json">${schema}</script>
<script type="application/ld+json">${breadcrumb}</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-G6YQ408CMT"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-G6YQ408CMT');</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#1b2a3b;--navy-deep:#0f1c28;--gold:#c49a2a;--gold-light:#d4aa40;--white:#f7f6f3;--gray-100:#f3f4f6;--gray-200:#e5e7eb;--gray-400:#9ca3af;--gray-500:#6b7280;--gray-700:#374151;--green:#15803d}
body{font-family:'Inter',system-ui,sans-serif;background:#f7f6f3;color:var(--gray-700);min-height:100vh;display:flex;flex-direction:column}
nav{background:var(--navy-deep);position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,.35)}
.nav-inner{max-width:1200px;margin:0 auto;padding:0 20px;height:58px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.nav-logo{display:flex;align-items:center;font-family:'Playfair Display',serif;font-size:20px;font-weight:700;color:#fff;text-decoration:none;flex-shrink:0}
.nav-logo img{width:30px;height:30px;margin-right:5px;display:block;flex-shrink:0}
.nav-logo-divider{border-left:1.5px solid var(--gold);height:28px;margin:0 6px;flex-shrink:0;align-self:center}
.nav-back{font-size:12px;font-weight:500;color:rgba(255,255,255,.7);text-decoration:none;display:flex;align-items:center;gap:4px;padding:6px 12px;border:1px solid rgba(255,255,255,.15);flex-shrink:0}
.nav-back:hover{background:rgba(255,255,255,.08);color:#fff}
.nav-back svg{width:12px;height:12px;stroke:currentColor;fill:none}
.breadcrumb{max-width:1200px;margin:0 auto;padding:14px 20px;font-size:12px;color:var(--gray-400);display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.breadcrumb a{color:var(--gray-500);text-decoration:none}.breadcrumb a:hover{color:var(--navy)}.breadcrumb span{color:var(--gray-400)}
.hero{max-width:1200px;margin:0 auto;padding:0 20px 32px;display:flex;gap:40px;align-items:flex-start}
.hero-img-wrap{flex-shrink:0;width:260px;background:#fff;border:1px solid var(--gray-200);padding:12px;display:flex;align-items:center;justify-content:center}
.hero-img-wrap img{max-width:100%;max-height:220px;object-fit:contain;display:block}
.hero-info{flex:1;min-width:0;padding-top:4px}
.hero-brand{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin-bottom:6px}
.hero-name{font-family:'Playfair Display',serif;font-size:clamp(18px,3vw,26px);font-weight:700;color:var(--navy);line-height:1.25;margin-bottom:14px;text-wrap:balance}
.best-price{display:inline-flex;align-items:center;gap:8px;background:var(--navy);color:#fff;font-size:13px;font-weight:600;padding:8px 14px;margin-bottom:8px}
.best-price strong{font-size:18px;color:var(--gold-light)}
.hero-cat{font-size:12px;color:var(--gray-400);margin-top:8px}
.hero-cat a{color:var(--gray-500);text-decoration:none}.hero-cat a:hover{color:var(--navy)}
.compare-wrap{max-width:1200px;margin:0 auto;padding:0 20px 48px}
.compare-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--navy);margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid var(--navy)}
.compare-table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--gray-200)}
.compare-table th{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--gray-400);text-align:left;padding:10px 14px;border-bottom:1px solid var(--gray-200);background:var(--gray-100)}
.compare-table td{padding:13px 14px;border-bottom:1px solid var(--gray-200);vertical-align:middle;font-size:13px}
.compare-table tr:last-child td{border-bottom:none}
.compare-table tr:hover{background:#fafafa}
.col-seller{font-weight:600;color:var(--navy)}
.col-price{font-size:15px;font-weight:700;color:var(--gray-700);font-variant-numeric:tabular-nums;white-space:nowrap}
.compare-table tr:first-child .col-price{color:var(--green)}
.stock{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:2px}
.in-stock{background:#dcfce7;color:var(--green)}
.check-stock{background:var(--gray-100);color:var(--gray-500)}
.buy-btn{display:inline-block;background:var(--gold);color:var(--navy-deep);font-size:11px;font-weight:700;letter-spacing:.04em;padding:7px 14px;text-decoration:none;white-space:nowrap}
.buy-btn:hover{opacity:.88}
footer{margin-top:auto;background:var(--navy-deep);padding:28px 20px;color:rgba(255,255,255,.45);font-size:12px;text-align:center;line-height:1.8}
footer a{color:rgba(255,255,255,.55);text-decoration:none}
.foot-links{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;margin-bottom:8px}
.disclaimer{max-width:640px;margin:0 auto;font-size:11px;line-height:1.7}
@media(max-width:680px){
  .hero{flex-direction:column;gap:20px}
  .hero-img-wrap{width:100%;max-width:300px}
  .compare-table th:nth-child(3),.compare-table td:nth-child(3){display:none}
  .nav-back span{display:none}
}
</style>
</head>
<body>
<nav>
  <div class="nav-inner">
    <a class="nav-logo" href="/"><img src="/nav-icon.png" width="30" height="30" alt="" aria-hidden="true"><span class="nav-logo-divider"></span>Ideal Armory</a>
    <a class="nav-back" href="${catUrl}"><svg viewBox="0 0 16 16"><polyline points="10 4 6 8 10 12" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg><span>All ${catName}</span></a>
  </div>
</nav>
<div class="breadcrumb">
  <a href="/">Home</a><span>&rsaquo;</span><a href="${catUrl}">${catName}</a><span>&rsaquo;</span><span>${safeName}</span>
</div>
<div class="hero">
  <div class="hero-img-wrap"><img src="${safeImg}" alt="${safeName}" loading="lazy"></div>
  <div class="hero-info">
    <div class="hero-brand">${safeBrand}</div>
    <h1 class="hero-name">${safeName}</h1>
    ${bestBadge}
    <div class="hero-cat">Category: <a href="${catUrl}">${catName}</a></div>
  </div>
</div>
<div class="compare-wrap">
  <div class="compare-title">Price Comparison &mdash; ${nSellers} ${nSellers === 1 ? 'Seller' : 'Sellers'}</div>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead><tr><th>Retailer</th><th>Price</th><th>Status</th><th></th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>
</div>
<footer>
  <div class="foot-links">
    <a href="/">Home</a><a href="${catUrl}">${catName}</a><a href="/about">About</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a>
  </div>
  <div class="disclaimer">Ideal Armory is a firearm price comparison platform. We do not sell firearms or accessories. All purchases are completed directly with licensed retailers and are subject to applicable federal and state law, background checks, and FFL transfer requirements. Prices shown are provided by retailers and may vary at checkout.</div>
</footer>
</body>
</html>`;

  fs.writeFileSync(path.join(OUT_DIR, `${slug}.html`), html, 'utf8');
  count++;
}

console.log(`  Generated ${count} product pages in /products/`);
