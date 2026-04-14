/**
 * Cloudflare Pages Function — /api/subscribe
 * Adds a contact to Brevo email list.
 *
 * Required environment secret in Cloudflare Pages dashboard:
 *   BREVO_API_KEY
 */

const CORS = {
  'Access-Control-Allow-Origin': 'https://idealarmory.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

export async function onRequestPost(context) {
  const { request, env } = context;

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
