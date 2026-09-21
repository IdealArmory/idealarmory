/**
 * Cloudflare Pages middleware
 * Detects known search engine crawlers and bypasses the JavaScript age gate
 * so Googlebot and other crawlers can index site content.
 *
 * Approach: inject a <style> that hides #age-gate, and a <script> that
 * pre-sets the localStorage key the gate checks — so even if the JS runs,
 * it finds the gate already "passed."
 */

const BOT_UA = /googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|facebookexternalhit|twitterbot|linkedinbot|ia_archiver|AhrefsBot|SemrushBot|MJ12bot/i;

export async function onRequest(context) {
  const ua = context.request.headers.get('User-Agent') || '';

  if (!BOT_UA.test(ua)) {
    return context.next();
  }

  // Fetch the page normally
  const response = await context.next();
  const contentType = response.headers.get('content-type') || '';

  // Only transform HTML responses
  if (!contentType.includes('text/html')) {
    return response;
  }

  const html = await response.text();

  // Two-layer bypass:
  // 1. CSS hides the gate immediately (no flash of gate content)
  // 2. Script sets localStorage so checkAgeGate() finds a valid entry
  const bypass = `<style>#age-gate{display:none!important}</style>` +
    `<script>try{var _x=Date.now()+31536000000;` +
    `localStorage.setItem('ia_age_verified',` +
    `JSON.stringify({verified:true,expiry:_x,type:'guest'}));}catch(e){}</script>`;

  const patched = html.replace('<head>', `<head>${bypass}`);

  const headers = new Headers(response.headers);
  headers.delete('content-length');

  return new Response(patched, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
