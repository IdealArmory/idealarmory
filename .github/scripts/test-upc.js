// test-upc.js
// Fetches ONE page of the EuroOptic catalog and reports:
// 1. All available field names
// 2. Whether UPC/GTIN data is present
// 3. Image availability rate

const ACCOUNT_SID = process.env.IMPACT_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.IMPACT_AUTH_TOKEN;
const CATALOG_ID  = process.env.IMPACT_CATALOG_ID;

if (!ACCOUNT_SID || !AUTH_TOKEN || !CATALOG_ID) {
  console.error('ERROR: Missing required environment variables.');
  process.exit(1);
}

const AUTH_HEADER = 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
const URL = `https://api.impact.com/Mediapartners/${ACCOUNT_SID}/Catalogs/${CATALOG_ID}/Items?PageSize=500&Page=1`;

async function main() {
  console.log('=== EuroOptic UPC Test (1 page) ===\n');
  const res = await fetch(URL, {
    headers: { 'Authorization': AUTH_HEADER, 'Accept': 'application/json' }
  });
  if (!res.ok) { console.error(`API error: ${res.status}`); process.exit(1); }
  const data = await res.json();
  const items = data.Items || [];
  console.log(`Items on page 1: ${items.length}\n`);

  if (!items.length) { console.error('No items returned.'); process.exit(1); }

  // All field names available
  const allKeys = new Set();
  items.forEach(item => Object.keys(item).forEach(k => allKeys.add(k)));
  console.log('=== Available fields ===');
  console.log([...allKeys].sort().join('\n'));

  // UPC availability
  const upcFields = ['Upc','UPC','GTIN','EAN','ISBN','Sku'];
  console.log('\n=== UPC / barcode field check ===');
  upcFields.forEach(f => {
    const count = items.filter(i => i[f] && i[f].toString().trim()).length;
    console.log(`  ${f}: ${count}/${items.length} products have a value`);
  });

  // Image availability
  const withImg = items.filter(i => i.ImageUrl || (i.AdditionalImageUrls && i.AdditionalImageUrls[0])).length;
  console.log(`\n=== Image availability ===`);
  console.log(`  Has image: ${withImg}/${items.length} (${Math.round(withImg/items.length*100)}%)`);

  // Sample first product with all fields
  console.log('\n=== First product (all fields) ===');
  console.log(JSON.stringify(items[0], null, 2));
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
