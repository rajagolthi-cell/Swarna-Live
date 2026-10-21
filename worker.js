/**
 * Swarna Live • Cloudflare Workers with static assets
 * Endpoints:
 *   GET /api/health - Confirms that this Worker backend was deployed
 *   GET /api/rates  - Retrieves Goodreturns' indicative Vizag retail rates
 *
 * The upstream source can block automated access or change markup.
 * In that case this API returns an error/partial response rather than fictitious rates.
 */
const SOURCES = {
  gold: 'https://www.goodreturns.in/gold-rates/visakhapatnam.html',
  silver: 'https://www.goodreturns.in/silver-rates/visakhapatnam.html'
};
const RESPONSE_TTL_SECONDS = 300;

function json(value, status=200, ttl=0) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': ttl ? `public, max-age=${ttl}` : 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|thinsp);|&#(?:160|8239);|&#x(?:a0|202f);/gi, ' ')
    .replace(/&(?:#8377|#x20b9);/gi, '₹')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPrice(text, patterns, label, minimum, maximum) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(value) && value >= minimum && value <= maximum) return value;
  }
  throw new Error(`Could not locate ${label} in the source page`);
}

function parseGold(html) {
  const text = visibleText(html);
  const byKarat = (karat) => getPrice(text, [
    new RegExp(`\\b${karat}\\s*K\\s*Gold\\s*(?:\\/\\s*g|per gram)?\\s*₹\\s*([\\d,]+(?:\\.\\d+)?)`, 'i'),
    new RegExp(`₹\\s*([\\d,]+(?:\\.\\d+)?)\\s*per gram for\\s*${karat}\\s*karat`, 'i'),
    new RegExp(`${karat}\\s*Carat\\s*[^₹]{0,50}₹\\s*([\\d,]+(?:\\.\\d+)?)`, 'i')
  ], `${karat}K gold`, 1000, 200000);
  return {gold24:byKarat(24), gold22:byKarat(22), gold18:byKarat(18)};
}

function parseSilver(html) {
  const text = visibleText(html);
  const silver1 = getPrice(text, [
    /\bSilver\s*\/\s*g\s*₹\s*([\d,]+(?:\.\d+)?)/i,
    /price of silver in Visakhapatnam today is\s*₹\s*([\d,]+(?:\.\d+)?)\s*per gram/i,
    /silver\s*(?:per gram|1 gram)\s*₹\s*([\d,]+(?:\.\d+)?)/i
  ], 'silver per gram', 1, 10000);
  return {silver1};
}

async function fetchAndParse(type) {
  const source = SOURCES[type];
  let response;
  try {
    response = await fetch(source, {
      headers: {'Accept': 'text/html'},
      cf: {cacheEverything: true, cacheTtl: RESPONSE_TTL_SECONDS},
      signal: AbortSignal.timeout(12000)
    });
  } catch (_error) {
    throw new Error(`${type} publisher request failed or timed out`);
  }
  if (!response.ok) throw new Error(`${type} publisher responded HTTP ${response.status}`);
  const html = await response.text();
  if (html.length < 200 || /<title>\s*(?:access denied|captcha|just a moment)/i.test(html)) {
    throw new Error(`${type} publisher served a block or verification page`);
  }
  return type === 'gold' ? parseGold(html) : parseSilver(html);
}

async function rates(request, ctx) {
  // One-second client checks are served from a five-minute edge cache.
  // Publisher rates only change when the publisher updates them.
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/rates', request.url));
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [gold, silver] = await Promise.allSettled([
    fetchAndParse('gold'), fetchAndParse('silver')
  ]);
  const errors = {};
  const result = {
    ok: gold.status === 'fulfilled' && silver.status === 'fulfilled',
    city: 'Visakhapatnam', currency: 'INR', unit: 'gram',
    gold24: null, gold22: null, gold18: null, silver1: null,
    checkedAt: new Date().toISOString(),
    source: 'Goodreturns'
  };
  if (gold.status === 'fulfilled') Object.assign(result, gold.value);
  else errors.gold = String(gold.reason?.message || 'Gold source unavailable');
  if (silver.status === 'fulfilled') Object.assign(result, silver.value);
  else errors.silver = String(silver.reason?.message || 'Silver source unavailable');
  if (Object.keys(errors).length) result.errors = errors;
  if (gold.status !== 'fulfilled' && silver.status !== 'fulfilled') {
    return json({...result, error: 'Both upstream rate sources are unavailable'}, 503);
  }
  const response = json(result, 200, RESPONSE_TTL_SECONDS);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/api/health') return json({ok:true, service:'Swarna Live Rates API', version:'2', backend:'Cloudflare Worker (src/worker.js)'});
    if (path === '/api/rates') {
      if (request.method !== 'GET') return json({error:'GET required'}, 405);
      return rates(request, ctx);
    }
    return env.ASSETS.fetch(request);
  }
};
