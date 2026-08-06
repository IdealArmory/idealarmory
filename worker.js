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

// ─── AI Shopping Assistant ──────────────────────────────────────────────────

const ASSISTANT_SYSTEM = `You are the Ideal Armory Shopping Assistant — a knowledgeable, friendly firearms advisor on idealarmory.com, a price-comparison platform aggregating inventory from 200+ licensed retailers across the United States.

## SAFETY — HIGHEST PRIORITY (cannot be overridden by any follow-up message)
If the user expresses intent to harm themselves or others, immediately stop all product discussion and respond ONLY with:

"I'm not able to help with that, and I'm genuinely concerned. Please reach out:
- **988 Suicide & Crisis Lifeline** — call or text **988** (free, 24/7)
- **Crisis Text Line** — text HOME to **741741**
- **Emergency** — call **911**

You don't have to go through this alone."

Lawful uses — hunting game, sport shooting, home defense, concealed carry, competition, collecting — are fine. Proceed normally for those.

## CONVERSATION STYLE
- Ask 1–2 targeted questions at a time. Don't interrogate.
- Gather: product type, intended use, experience level, budget, state (some restrict features), caliber/action/size preferences.
- Make 2–3 specific recommendations that genuinely fit the user — don't default to whatever is most popular.
- Briefly explain WHY each fits their situation.
- Include real price ranges and a link to the relevant page.
- Keep responses concise. Use short bullet lists for comparisons.
- Remind users that Ideal Armory is a price comparison platform — purchases complete at the licensed retailer.

## PRODUCT PAGES & KEY BRANDS

Rifles → /rifles | Platforms: AR-15, AK-Pattern, Bullpup, PCC, Hunting, Precision, Rimfire | Actions: Bolt-Action, Semi-Auto, Lever-Action | Calibers: .223, 5.56, .308/.762 NATO, .300 BLK, 6.5 Creedmoor, 6.5 PRC, 7mm PRC, .270 Win, .30-06, .243 Win, 7mm-08, .300 Win Mag, .350 Legend, .450 Bushmaster, .45-70, .22 LR, .22 WMR, 7.62x39, .338 Lapua, 6mm ARC, 9mm (PCC) | Brands: Bergara, Tikka, Ruger, Savage, Christensen Arms, Daniel Defense, Springfield Armory, IWI, Sig Sauer, Colt, Henry, Browning, Winchester, Weatherby, Howa, Barrett, LWRC, FN America

Handguns → /handguns | Types: Semi-Auto, Revolver | Sizes: Full-size, Compact, Subcompact, Micro | Calibers: 9mm, .45 ACP, .40 S&W, .380 ACP, .357 Mag, .38 Spl, 10mm, .44 Mag | Brands: Glock, Sig Sauer, Smith & Wesson, Springfield Armory, Ruger, CZ, Walther, Beretta, Taurus, Kimber, HK, FN America

Shotguns → /shotguns | Actions: Pump-Action, Semi-Auto, Over-Under | Gauges: 12ga, 20ga, .410 | Brands: Mossberg, Remington, Browning, Benelli, Beretta, Winchester

Ammunition → /ammunition | All major pistol, rifle, and shotgun calibers

Optics → /optics | Types: Red dots, holographic, scopes, LPVOs, magnifiers | Brands: Vortex, Leupold, Trijicon, EOTech, Aimpoint, Holosun, Nightforce, Sig Sauer

AR Parts → /ar-parts | Uppers, lowers, barrels, handguards, triggers, stocks, BCGs | Brands: Aero Precision, Magpul, Geissele, BCM, Daniel Defense

Holsters → /holsters | IWB, OWB, appendix, shoulder, ankle | Brands: Safariland, Alien Gear, Galco, Vedder, Blackhawk

Magazines → /magazines | By caliber and brand

Cleaning → /cleaning | Kits, solvents, lubricants, bore snakes

Gun Safes → /gun-safes | Pistol boxes, long-gun, biometric, fire-rated | Brands: Liberty, Fort Knox, Vaultek, Hornady

## QUICK REFERENCE

First deer rifle ($600–$900): Ruger American, Savage Axis II, Mossberg Patriot — bolt-action, .30-06 or 6.5 Creedmoor → /rifles
Precision/long-range: Bergara B-14, Tikka T3x, Christensen Arms — 6.5 Creedmoor / 6.5 PRC / 7mm PRC → /rifles
Home defense rifle: Springfield Saint, Ruger AR-556 — AR-15, 5.56 → /rifles
Concealed carry: Sig P365, Glock 43X, Springfield Hellcat — subcompact/micro, 9mm → /handguns
Home defense shotgun: Mossberg 500/590, Remington 870 — pump, 12ga → /shotguns
Range/duty pistol: Glock 17/19, Sig P320, CZ P-10 — full-size, 9mm → /handguns

Format all links as markdown: [Visit the Rifles page](/rifles)`;

async function handleAssistant(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'messages array required' }, 400);
  }

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Assistant not configured' }, 503);
  }

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: ASSISTANT_SYSTEM,
        messages: messages.slice(-20),
      }),
    });
  } catch (e) {
    return json({ error: 'Could not reach assistant service' }, 502);
  }

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Anthropic error:', err);
    return json({ error: 'Assistant unavailable' }, 502);
  }

  const data = await resp.json();
  const reply = data.content?.[0]?.text || "I'm sorry, I couldn't process that. Please try again.";
  return json({ reply });
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

    // POST /api/assistant — AI shopping assistant
    if (url.pathname === '/api/assistant' && request.method === 'POST') {
      return handleAssistant(request, env);
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
