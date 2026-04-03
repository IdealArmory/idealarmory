/**
 * Ideal Armory — Cloudflare Worker
 * Handles API routes securely (BREVO_API_KEY never exposed to browser)
 * All other requests fall through to static assets.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://idealarmory.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

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

  const source   = body.source || 'newsletter';
  const listIds  = body.listIds || [2]; // Brevo list ID — update if you rename your list

  const brevoPayload = {
    email,
    listIds,
    attributes: {
      SOURCE: source,
      ...(body.attributes || {}),
    },
    updateEnabled: true, // silently update if contact already exists
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

  // 201 = created, 204 = updated (no body)
  if (brevoRes.status === 201 || brevoRes.status === 204) {
    return json({ ok: true });
  }

  let errData = {};
  try { errData = await brevoRes.json(); } catch {}

  // Duplicate contact with updateEnabled should not happen, but handle gracefully
  if (errData.code === 'duplicate_parameter') {
    return json({ ok: true });
  }

  return json({ error: errData.message || 'Subscription failed' }, 400);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST /api/subscribe — add contact to Brevo
    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      return handleSubscribe(request, env);
    }

    // Sitemap — fetch from assets and force correct XML content-type
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
