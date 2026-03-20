// Cloudflare Pages Function — reCAPTCHA Enterprise token verification
// Deployed at: /api/verify-recaptcha
//
// Required Cloudflare environment secret:
//   RECAPTCHA_API_KEY  — Google Cloud API key restricted to reCAPTCHA Enterprise API

const SITE_KEY   = '6LfmAIQsAAAAAKa0wtP56CPLObXiKGpqeP5DNV6P';
const PROJECT_ID = 'ideal-armory-1772999090474';
const MIN_SCORE  = 0.5; // 0.0 = definitely bot, 1.0 = definitely human

const CORS = {
  'Access-Control-Allow-Origin':  'https://idealarmory.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.RECAPTCHA_API_KEY;
  if (!apiKey) {
    return json({ success: false, error: 'Server misconfiguration' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: 'Invalid request body' }, 400); }

  const { token, action } = body;
  if (!token) return json({ success: false, error: 'Missing token' }, 400);

  const url = `https://recaptchaenterprise.googleapis.com/v1/projects/${PROJECT_ID}/assessments?key=${apiKey}`;

  let assessment;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: {
          token,
          expectedAction: action || 'submit',
          siteKey: SITE_KEY,
        },
      }),
    });
    assessment = await res.json();
  } catch (err) {
    return json({ success: false, error: 'Verification request failed' }, 502);
  }

  const valid  = assessment?.tokenProperties?.valid  ?? false;
  const score  = assessment?.riskAnalysis?.score     ?? 0;
  const passed = valid && score >= MIN_SCORE;

  // Log for Cloudflare dashboard visibility (not exposed to client)
  console.log(`[reCAPTCHA] action=${action} valid=${valid} score=${score} passed=${passed}`);

  return json({ success: passed, score, valid }, 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
