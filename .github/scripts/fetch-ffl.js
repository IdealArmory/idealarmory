// fetch-ffl.js
// Downloads the ATF Federal Firearms Licensee (FFL) dataset and the GeoNames
// US ZIP-code centroid file, joins them, filters to dealer-relevant license
// types, splits by state, and writes data/ffl/<STATE>.json files.
//
// Runs monthly via GitHub Actions (refresh-ffl.yml).
// No API keys required — both data sources are public.

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'ffl');

// License types to keep: 01=Dealer, 02=Pawnbroker, 07=Manufacturer, 08=Importer
const KEEP_TYPES = new Set(['01', '02', '07', '08']);

// ── helpers ──────────────────────────────────────────────────────────────────

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 IdealArmory-FFL-Updater/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        return download(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', err => { fs.unlink(destPath, () => {}); reject(err); });
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 IdealArmory-FFL-Updater/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function unzipFile(zipPath, outDir) {
  return new Promise((resolve, reject) => {
    const AdmZip = (() => {
      try { return require('adm-zip'); } catch (e) { return null; }
    })();

    if (AdmZip) {
      try {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(outDir, true);
        const entries = zip.getEntries().map(e => e.entryName);
        resolve(entries);
      } catch (e) { reject(e); }
      return;
    }

    // Fallback: use system unzip
    const { execSync } = require('child_process');
    try {
      execSync(`unzip -o "${zipPath}" -d "${outDir}"`, { stdio: 'pipe' });
      const files = fs.readdirSync(outDir);
      resolve(files);
    } catch (e) { reject(e); }
  });
}

// ── Step 1: Build ZIP → {lat, lng} lookup from GeoNames ──────────────────────

async function buildZipCentroids(tmpDir) {
  const zipFile  = path.join(tmpDir, 'US.zip');
  const geoDir   = path.join(tmpDir, 'geonames');
  const geoUrl   = 'https://download.geonames.org/export/zip/US.zip';

  console.log('Downloading GeoNames US ZIP centroids...');
  await download(geoUrl, zipFile);

  fs.mkdirSync(geoDir, { recursive: true });
  await unzipFile(zipFile, geoDir);

  // Find the tab-separated file (US.txt)
  const txtFile = fs.readdirSync(geoDir).find(f => f.toLowerCase().endsWith('.txt') && !f.toLowerCase().includes('readme'));
  if (!txtFile) throw new Error('GeoNames US.txt not found in zip');

  const lines = fs.readFileSync(path.join(geoDir, txtFile), 'utf8').split('\n');
  const centroids = {};
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 11) continue;
    const zip = (parts[1] || '').trim();
    const lat = parseFloat(parts[9]);
    const lng = parseFloat(parts[10]);
    if (zip && !isNaN(lat) && !isNaN(lng)) {
      // Keep first occurrence (most accurate per GeoNames accuracy field)
      if (!centroids[zip]) centroids[zip] = { lat: +lat.toFixed(4), lng: +lng.toFixed(4) };
    }
  }
  console.log(`  Built centroid lookup for ${Object.keys(centroids).length} ZIP codes`);
  return centroids;
}

// ── Step 2: Find ATF FFL download URL ────────────────────────────────────────

async function findAtfUrl() {
  // ATF publishes monthly FFL data; try several known URL patterns
  const now  = new Date();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = String(now.getFullYear());
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const pmm  = String(prev.getMonth() + 1).padStart(2, '0');
  const pyyyy = String(prev.getFullYear());

  const candidates = [
    // Current month, then previous month as fallback
    `https://www.atf.gov/firearms/docs/undefined/allstates${mm}${yyyy}/download`,
    `https://www.atf.gov/firearms/docs/undefined/allstates${pmm}${pyyyy}/download`,
    `https://www.atf.gov/firearms/docs/undefined/allstatesffl${mm}${yyyy}/download`,
    `https://www.atf.gov/firearms/docs/undefined/allstatesffl${pmm}${pyyyy}/download`,
  ];

  // Also try scraping the ATF FFL listing page for the actual link
  try {
    const page = await fetchText('https://www.atf.gov/firearms/listing-federal-firearms-licensees');
    const match = page.match(/href="([^"]+allstates[^"]+\/download[^"]*)"/i);
    if (match) {
      const href = match[1].startsWith('http') ? match[1] : 'https://www.atf.gov' + match[1];
      console.log(`  Found ATF URL via page scrape: ${href}`);
      candidates.unshift(href);
    }
  } catch (e) {
    console.warn('  Could not scrape ATF page:', e.message);
  }

  return candidates;
}

// ── Step 3a: Parse ATF zip already on disk ────────────────────────────────────

async function parseAtfZip(atfPath, tmpDir, zipCentroids) {
  const atfDir = path.join(tmpDir, 'atf');
  fs.mkdirSync(atfDir, { recursive: true });
  await unzipFile(atfPath, atfDir);

  const txtFile = fs.readdirSync(atfDir).find(f => /\.(txt|csv)$/i.test(f));
  if (!txtFile) throw new Error('ATF text file not found in zip');

  return parseAtfText(path.join(atfDir, txtFile), zipCentroids);
}

// ── Step 3b: Download and parse ATF FFL data ──────────────────────────────────

async function fetchAtfData(tmpDir, zipCentroids) {
  const urls = await findAtfUrl();
  let atfPath = null;

  for (const url of urls) {
    const dest = path.join(tmpDir, 'atf_ffl.zip');
    console.log(`  Trying: ${url}`);
    try {
      await download(url, dest);
      atfPath = dest;
      console.log(`  Downloaded ATF data from: ${url}`);
      break;
    } catch (e) {
      console.warn(`  Failed (${e.message}), trying next...`);
    }
  }

  if (!atfPath) throw new Error('Could not download ATF FFL data from any known URL');

  const atfDir = path.join(tmpDir, 'atf');
  fs.mkdirSync(atfDir, { recursive: true });
  await unzipFile(atfPath, atfDir);

  const txtFile2 = fs.readdirSync(atfDir).find(f => /\.(txt|csv)$/i.test(f));
  if (!txtFile2) throw new Error('ATF text file not found in zip');
  return parseAtfText(path.join(atfDir, txtFile2), zipCentroids);
}

// ── Shared ATF text parser ────────────────────────────────────────────────────

function parseAtfText(filePath, zipCentroids) {
  const raw = fs.readFileSync(filePath, 'latin1');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  console.log(`  Parsing ${lines.length} ATF lines...`);

  const header = lines[0].split('|').map(h => h.trim().toLowerCase());

  function col(names) {
    for (const n of names) {
      const idx = header.findIndex(h => h.includes(n));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  const iType   = col(['lic_type', 'type']);
  const iName   = col(['lic_name', 'licensee_name', 'licensee name']);
  const iBiz    = col(['lic_bizname', 'business_name', 'biz_name', 'dba', 'biz name']);
  const iStreet = col(['premise_street', 'street', 'prem_street', 'address']);
  const iCity   = col(['premise_city', 'city', 'prem_city']);
  const iState  = col(['premise_state', 'state', 'prem_state']);
  const iZip    = col(['premise_zip', 'zip_code', 'zip', 'prem_zip']);
  const iPhone  = col(['voice_phone', 'phone']);
  console.log('  Column indices:', { iType, iName, iBiz, iStreet, iCity, iState, iZip, iPhone });

  const byState = {};
  let kept = 0, skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('|');
    const rawType = iType >= 0 ? (parts[iType] || '').trim().padStart(2, '0') : '';
    if (!KEEP_TYPES.has(rawType)) { skipped++; continue; }

    const state = iState >= 0 ? (parts[iState] || '').trim().toUpperCase() : '';
    if (!state || state.length !== 2) { skipped++; continue; }

    const zip   = iZip    >= 0 ? (parts[iZip]    || '').trim().slice(0, 5) : '';
    const coord = zipCentroids[zip] || null;
    if (!coord) { skipped++; continue; }  // skip if ZIP not in centroid table

    const name  = iName   >= 0 ? (parts[iName]   || '').trim() : '';
    const biz   = iBiz    >= 0 ? (parts[iBiz]     || '').trim() : '';
    const addr  = iStreet >= 0 ? (parts[iStreet]  || '').trim() : '';
    const city  = iCity   >= 0 ? (parts[iCity]    || '').trim() : '';
    const phone = iPhone  >= 0 ? (parts[iPhone]   || '').trim().replace(/\D/g, '') : '';

    if (!byState[state]) byState[state] = [];
    byState[state].push({
      n: name,          // lic_name
      b: biz,           // dba / business name
      a: addr,
      c: city,
      s: state,
      z: zip,
      p: phone,
      t: rawType,
      lat: coord.lat,
      lng: coord.lng
    });
    kept++;
  }

  console.log(`  Kept: ${kept} | Skipped: ${skipped}`);
  console.log(`  States with data: ${Object.keys(byState).sort().join(', ')}`);
  return byState;
}

// ── Step 4: Write per-state JSON files ────────────────────────────────────────

function writeStateFiles(byState) {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Remove old state files
  if (fs.existsSync(OUT_DIR)) {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (f.endsWith('.json') && f !== 'index.json') fs.unlinkSync(path.join(OUT_DIR, f));
    }
  }

  const summary = {};
  for (const [state, dealers] of Object.entries(byState)) {
    const outPath = path.join(OUT_DIR, state + '.json');
    fs.writeFileSync(outPath, JSON.stringify(dealers), 'utf8');
    summary[state] = dealers.length;
    console.log(`  ${state}: ${dealers.length} dealers → ${path.basename(outPath)}`);
  }

  // Write index file with counts + last updated
  const index = {
    updated: new Date().toISOString().slice(0, 10),
    states: summary,
    total: Object.values(summary).reduce((a, b) => a + b, 0)
  };
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  console.log(`\nTotal FFL dealers written: ${index.total} across ${Object.keys(summary).length} states`);
  console.log(`Last updated: ${index.updated}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
// Usage:
//   node fetch-ffl.js                    — downloads ATF zip automatically
//   node fetch-ffl.js /path/to/atf.zip  — uses a pre-downloaded ATF zip

async function main() {
  const predownloadedZip = process.argv[2] || null;
  const tmpDir = path.join(require('os').tmpdir(), 'ideal-armory-ffl-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  console.log(`Using temp dir: ${tmpDir}`);

  try {
    const zipCentroids = await buildZipCentroids(tmpDir);

    let byState;
    if (predownloadedZip && fs.existsSync(predownloadedZip)) {
      console.log(`Using pre-downloaded ATF file: ${predownloadedZip}`);
      // Copy to tmp so extraction lands in a clean dir
      const dest = path.join(tmpDir, 'atf_ffl.zip');
      fs.copyFileSync(predownloadedZip, dest);
      byState = await parseAtfZip(dest, tmpDir, zipCentroids);
    } else {
      byState = await fetchAtfData(tmpDir, zipCentroids);
    }

    writeStateFiles(byState);
    console.log('\nFFL data refresh complete.');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch(err => { console.error('FFL refresh failed:', err); process.exit(1); });
