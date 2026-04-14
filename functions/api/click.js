/**
 * Cloudflare Pages Function — /api/click
 * Logs outbound retailer click to KV, then redirects to retailer URL.
 *
 * KV namespace binding required in Cloudflare Pages > Settings > Functions:
 *   Variable name: CLICK_DATA
 *   KV Namespace:  CLICK_DATA
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url      = new URL(request.url);
  const target   = url.searchParams.get('url');
  const retailer = (url.searchParams.get('retailer') || 'unknown').trim();
  const product  = (url.searchParams.get('product')  || '').trim();
  const cat      = (url.searchParams.get('cat')      || '').trim();
  const price    = (url.searchParams.get('price')    || '').trim();

  if (!target) return new Response('Missing url param', { status: 400 });

  // Validate destination is a real http/https URL
  let dest;
  try {
    dest = new URL(target);
    if (dest.protocol !== 'https:' && dest.protocol !== 'http:') throw new Error();
  } catch {
    return new Response('Invalid url', { status: 400 });
  }

  // Log to KV (non-blocking — never delay the redirect)
  if (env.CLICK_DATA) {
    try {
      const ts  = Date.now();
      const key = `click:${ts}:${Math.random().toString(36).slice(2, 7)}`;
      const val = JSON.stringify({ ts, retailer, product, cat, price: parseFloat(price) || 0 });
      await env.CLICK_DATA.put(key, val, { expirationTtl: 7_776_000 });

      const cKey   = `count:${retailer}`;
      const cRaw   = await env.CLICK_DATA.get(cKey);
      const cCount = parseInt(cRaw || '0', 10) + 1;
      await env.CLICK_DATA.put(cKey, String(cCount));
    } catch (e) {
      console.error('KV write failed:', e.message);
    }
  }

  return Response.redirect(dest.toString(), 302);
}
