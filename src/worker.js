
/**
 * Swarna Live - Cloudflare Worker
 * Visakhapatnam Gold & Silver Rates
 */

const SOURCES = {
  gold: "https://www.goodreturns.in/gold-rates/visakhapatnam.html",
  silver: "https://www.goodreturns.in/silver-rates/visakhapatnam.html"
};

const CACHE_SECONDS = 300;

function json(data, status = 200, ttl = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": ttl
        ? `public, max-age=${ttl}`
        : "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|thinsp);|&#(?:160|8239);|&#x(?:a0|202f);/gi, " ")
    .replace(/&(?:#8377|#x20b9);/gi, "₹")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function getPrice(text, patterns, label, minimum, maximum) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);

    if (!match) continue;

    const value = Number(match[1].replace(/,/g, ""));

    if (
      Number.isFinite(value) &&
      value >= minimum &&
      value <= maximum
    ) {
      return value;
    }
  }

  throw new Error(`Could not locate ${label} in source page`);
}

function parseGold(html) {
  const text = visibleText(html);

  function goldPrice(karat) {
    return getPrice(
      text,
      [
        new RegExp(
          `\\b${karat}\\s*K\\s*Gold\\s*(?:\\/\\s*g|per gram)?\\s*₹\\s*([\\d,]+(?:\\.\\d+)?)`,
          "i"
        ),
        new RegExp(
          `₹\\s*([\\d,]+(?:\\.\\d+)?)\\s*per gram for\\s*${karat}\\s*karat`,
          "i"
        ),
        new RegExp(
          `${karat}\\s*Carat\\s*[^₹]{0,50}₹\\s*([\\d,]+(?:\\.\\d+)?)`,
          "i"
        )
      ],
      `${karat}K gold`,
      1000,
      200000
    );
  }

  return {
    gold24: goldPrice(24),
    gold22: goldPrice(22),
    gold18: goldPrice(18)
  };
}

function parseSilver(html) {
  const text = visibleText(html);

  const price = getPrice(
    text,
    [
      /\bSilver\s*\/\s*g\s*₹\s*([\d,]+(?:\.\d+)?)/i,
      /price of silver in Visakhapatnam today is\s*₹\s*([\d,]+(?:\.\d+)?)\s*per gram/i,
      /silver\s*(?:per gram|1 gram)\s*₹\s*([\d,]+(?:\.\d+)?)/i
    ],
    "silver per gram",
    1,
    10000
  );

  return { silver1: price };
}

async function fetchPrice(type) {
  let response;

  try {
    response = await fetch(SOURCES[type], {
      headers: {
        Accept: "text/html"
      },
      cf: {
        cacheEverything: true,
        cacheTtl: CACHE_SECONDS
      },
      signal: AbortSignal.timeout(12000)
    });
  } catch (error) {
    throw new Error(`${type} source request failed`);
  }

  if (!response.ok) {
    throw new Error(
      `${type} source returned HTTP ${response.status}`
    );
  }

  const html = await response.text();

  if (
    html.length < 200 ||
    /<title>\s*(?:access denied|captcha|just a moment)/i.test(html)
  ) {
    throw new Error(`${type} source is blocked`);
  }

  if (type === "gold") {
    return parseGold(html);
  }

  return parseSilver(html);
}

async function getRates(request, ctx) {
  const cache = caches.default;

  const cacheKey = new Request(
    new URL("/api/rates", request.url)
  );

  const cachedResponse = await cache.match(cacheKey);

  if (cachedResponse) {
    return cachedResponse;
  }

  const [gold, silver] = await Promise.allSettled([
    fetchPrice("gold"),
    fetchPrice("silver")
  ]);

  const result = {
    ok:
      gold.status === "fulfilled" &&
      silver.status === "fulfilled",
    city: "Visakhapatnam",
    currency: "INR",
    unit: "gram",
    gold24: null,
    gold22: null,
    gold18: null,
    silver1: null,
    source: "Goodreturns",
    checkedAt: new Date().toISOString()
  };

  const errors = {};

  if (gold.status === "fulfilled") {
    Object.assign(result, gold.value);
  } else {
    errors.gold = String(
      gold.reason?.message || "Gold rates unavailable"
    );
  }

  if (silver.status === "fulfilled") {
    Object.assign(result, silver.value);
  } else {
    errors.silver = String(
      silver.reason?.message || "Silver rates unavailable"
    );
  }

  if (Object.keys(errors).length > 0) {
    result.errors = errors;
  }

  if (
    gold.status !== "fulfilled" &&
    silver.status !== "fulfilled"
  ) {
    return json(
      {
        ...result,
        error: "Both price sources are unavailable"
      },
      503
    );
  }

  const response = json(
    result,
    200,
    CACHE_SECONDS
  );

  ctx.waitUntil(
    cache.put(cacheKey, response.clone())
  );

  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health") {
      return json({
        ok: true,
        service: "Swarna Live",
        backend: "Cloudflare Worker",
        message: "Backend is running"
      });
    }

    if (path === "/api/rates") {
      if (request.method !== "GET") {
        return json(
          { error: "GET required" },
          405
        );
      }

      return getRates(request, ctx);
    }

    return env.ASSETS.fetch(request);
  }
};
