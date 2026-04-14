/**
 * Cloudflare Pages Function — /api/stats
 * Returns click analytics JSON (password protected).
 *
 * Required in Cloudflare Pages > Settings > Functions:
 *   KV binding:  CLICK_DATA
 *   Secret:      STATS_PASSWORD
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pw  = url.searchParams.get('pw');

  if (!env.STATS_PASSWORD || pw !== env.STATS_PASSWORD) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (!env.CLICK_DATA) {
    return json({ error: 'CLICK_DATA KV namespace not bound' }, 503);
  }

  const countList = await env.CLICK_DATA.list({ prefix: 'count:' });
  const retailers = {};
  for (const k of countList.keys) {
    const name = k.name.replace('count:', '');
    retailers[name] = parseInt(await env.CLICK_DATA.get(k.name) || '0', 10);
  }

  const clickList = await env.CLICK_DATA.list({ prefix: 'click:', limit: 500 });
  const recent = [];
  const vals = await Promise.all(clickList.keys.map(k => env.CLICK_DATA.get(k.name)));
  for (const v of vals) {
    if (v) { try { recent.push(JSON.parse(v)); } catch {} }
  }
  recent.sort((a, b) => b.ts - a.ts);

  const daily = {};
  for (const c of recent) {
    const day = new Date(c.ts).toISOString().slice(0, 10);
    daily[day] = (daily[day] || 0) + 1;
  }

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
