/**
 * Ideal Armory — Cloudflare Worker
 * - /api/subscribe  → adds contact to Brevo email list
 * - /api/click      → logs outbound retailer click to KV, then redirects
 * - /api/stats      → returns click data as JSON (password protected)
 * - /sitemap.xml    → serves sitemap with correct XML content-type
 * - everything else → serves static assets
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://idealarmory.com',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─── Brevo subscribe ────────────────────────────────────────────────────────

async function handleSubscribe(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email address' }, 400);
  }

  const source  = body.source  || 'newsletter';
  const listIds = body.listIds || [2];

  const brevoPayload = {
    email,
    listIds,
    attributes: { SOURCE: source, ...(body.attributes || {}) },
    updateEnabled: true,
  };

  let brevoRes;
  try {
    brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(brevoPayload),
    });
  } catch (e) {
    return json({ error: 'Could not reach email service' }, 502);
  }

  if (brevoRes.status === 201 || brevoRes.status === 204) return json({ ok: true });

  let errData = {};
  try { errData = await brevoRes.json(); } catch {}
  if (errData.code === 'duplicate_parameter') return json({ ok: true });

  return json({ error: errData.message || 'Subscription failed' }, 400);
}

// ─── Click tracking ─────────────────────────────────────────────────────────

async function handleClick(request, env) {
  const url      = new URL(request.url);
  const target   = url.searchParams.get('url');
  const retailer = (url.searchParams.get('retailer') || 'unknown').trim();
  const product  = (url.searchParams.get('product')  || '').trim();
  const cat      = (url.searchParams.get('cat')      || '').trim();
  const price    = (url.searchParams.get('price')    || '').trim();

  // Must have a destination
  if (!target) return new Response('Missing url param', { status: 400 });

  // Only allow redirects to http/https URLs
  let dest;
  try {
    dest = new URL(target);
    if (dest.protocol !== 'https:' && dest.protocol !== 'http:') throw new Error();
  } catch {
    return new Response('Invalid url', { status: 400 });
  }

  // Log to KV if binding exists
  if (env.CLICK_DATA) {
    try {
      const ts  = Date.now();
      const key = `click:${ts}:${Math.random().toString(36).slice(2, 7)}`;
      const val = JSON.stringify({ ts, retailer, product, cat, price: parseFloat(price) || 0 });
      // Keep individual click records for 90 days
      await env.CLICK_DATA.put(key, val, { expirationTtl: 7_776_000 });

      // Also maintain a lightweight per-retailer counter
      const cKey   = `count:${retailer}`;
      const cRaw   = await env.CLICK_DATA.get(cKey);
      const cCount = parseInt(cRaw || '0', 10) + 1;
      await env.CLICK_DATA.put(cKey, String(cCount));
    } catch (e) {
      // Never block the redirect on a logging failure
      console.error('KV write failed:', e.message);
    }
  }

  // Redirect visitor to the retailer
  return Response.redirect(dest.toString(), 302);
}

// ─── Stats dashboard data ────────────────────────────────────────────────────

async function handleStats(request, env) {
  // Simple password gate — set STATS_PASSWORD as a Cloudflare Worker secret
  const url = new URL(request.url);
  const pw  = url.searchParams.get('pw');
  if (!env.STATS_PASSWORD || pw !== env.STATS_PASSWORD) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (!env.CLICK_DATA) {
    return json({ error: 'CLICK_DATA KV namespace not bound' }, 503);
  }

  // Fetch retailer summary counters
  const countList = await env.CLICK_DATA.list({ prefix: 'count:' });
  const retailers = {};
  for (const k of countList.keys) {
    const name = k.name.replace('count:', '');
    retailers[name] = parseInt(await env.CLICK_DATA.get(k.name) || '0', 10);
  }

  // Fetch recent individual clicks (up to 500)
  const clickList = await env.CLICK_DATA.list({ prefix: 'click:', limit: 500 });
  const recent = [];
  // Read in parallel for speed
  const vals = await Promise.all(clickList.keys.map(k => env.CLICK_DATA.get(k.name)));
  for (const v of vals) {
    if (v) { try { recent.push(JSON.parse(v)); } catch {} }
  }
  recent.sort((a, b) => b.ts - a.ts); // newest first

  // Daily breakdown from recent clicks
  const daily = {};
  for (const c of recent) {
    const day = new Date(c.ts).toISOString().slice(0, 10);
    daily[day] = (daily[day] || 0) + 1;
  }

  // Category breakdown
  const cats = {};
  for (const c of recent) {
    if (c.cat) cats[c.cat] = (cats[c.cat] || 0) + 1;
  }

  return json({
    totalClicks  : Object.values(retailers).reduce((s, n) => s + n, 0),
    byRetailer   : retailers,
    byDay        : daily,
    byCategory   : cats,
    recentClicks : recent.slice(0, 100),
  });
}

// ─── Main fetch handler ──────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST /api/subscribe
    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      return handleSubscribe(request, env);
    }

    // GET /api/click  — log + redirect
    if (url.pathname === '/api/click') {
      return handleClick(request, env);
    }

    // GET /api/stats — click data (password protected)
    if (url.pathname === '/api/stats') {
      return handleStats(request, env);
    }

    // Sitemap — force correct XML content-type
    // (SPA fallback can otherwise intercept .xml and return index.html)
    if (url.pathname === '/sitemap.xml') {
      const asset = await env.ASSETS.fetch(request);
      return new Response(asset.body, {
        status: asset.status,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // Everything else → serve static assets
    return env.ASSETS.fetch(request);
  },
};
