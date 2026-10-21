
const PROVIDER = "https://ibja-api.vercel.app";
const CACHE_SECONDS = 600;

function asJson(value, status = 200, cacheSeconds = 0) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheSeconds
        ? `public, max-age=${cacheSeconds}`
        : "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function parseNumber(raw) {
  if (raw === undefined || raw === null) return null;

  const clean = String(raw)
    .trim()
    .replace(/[₹,\s]/g, "");

  if (!/^\d+(?:\.\d+)?$/.test(clean)) return null;

  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}

function normalized(raw, divisor, rawMin, rawMax) {
  const n = parseNumber(raw);
  if (n === null || n < rawMin || n > rawMax) {
    return null;
  }

  return Math.round((n / divisor) * 100) / 100;
}

function preferredRate(data, label, divisor, rawMin, rawMax) {
  for (const session of ["PM", "AM"]) {
    const value = normalized(
      data?.[`lbl${label}_${session}`],
      divisor,
      rawMin,
      rawMax
    );

    if (value !== null) return { value, session };
  }

  return { value: null, session: null };
}

async function readApi(path) {
  let response;

  try {
    response = await fetch(`${PROVIDER}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    throw new Error(`Connection to IBJA API failed (${path})`);
  }

  if (!response.ok) {
    throw new Error(
      `IBJA API ${path} returned HTTP ${response.status}`
    );
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`IBJA API ${path} returned invalid JSON`);
  }
}

async function rates(request, ctx) {
  const cache = caches.default;

  const cacheKey = new Request(
    new URL("/api/rates", request.url).toString()
  );

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [goldOutcome, silverOutcome] =
    await Promise.allSettled([
      readApi("/latest"),
      readApi("/silver/latest")
    ]);

  const result = {
    ok: false,
    city: null,
    market: "India",
    source: "Unofficial IBJA API",
    currency: "INR",
    unit: "gram",
    gold24: null,
    gold22: null,
    gold18: null,
    silver1: null,
    sourceDate: null,
    checkedAt: new Date().toISOString(),
    note: "National IBJA benchmark; excludes GST and making charges."
  };

  const errors = {};
  let goldComplete = false;
  let silverComplete = false;

  if (goldOutcome.status === "fulfilled") {
    const data = goldOutcome.value;

    const gold24 = preferredRate(
      data, "Gold999", 10, 30000, 600000
    );

    const gold22 = preferredRate(
      data, "Gold916", 10, 30000, 600000
    );

    const gold18 = preferredRate(
      data, "Gold750", 10, 30000, 600000
    );

    result.gold24 = gold24.value;
    result.gold22 = gold22.value;
    result.gold18 = gold18.value;
    result.goldSession = gold24.session;

    result.sourceDate =
      /^\d{4}-\d{2}-\d{2}$/.test(data?.date || "")
        ? data.date
        : null;

    goldComplete = [
      result.gold24,
      result.gold22,
      result.gold18
    ].every(v => v !== null);

    if (!goldComplete) {
      errors.gold = "Missing or unexpected gold values";
    }
  } else {
    errors.gold = goldOutcome.reason?.message ||
      "Gold source unavailable";
  }

  if (silverOutcome.status === "fulfilled") {
    const silver = preferredRate(
      silverOutcome.value,
      "Silver999",
      1000,
      10000,
      2000000
    );

    result.silver1 = silver.value;
    result.silverSession = silver.session;
    silverComplete = silver.value !== null;

    if (!silverComplete) {
      errors.silver = "Missing or unexpected silver value";
    }
  } else {
    errors.silver = silverOutcome.reason?.message ||
      "Silver source unavailable";
  }

  result.ok = goldComplete && silverComplete;

  if (Object.keys(errors).length) {
    result.errors = errors;
  }

  const noRates = [
    result.gold24,
    result.gold22,
    result.gold18,
    result.silver1
  ].every(v => v === null);

  if (noRates) {
    return asJson({
      ...result,
      error: "No valid rates available from IBJA API"
    }, 502);
  }

  const output = asJson(result, 200, CACHE_SECONDS);

  ctx.waitUntil(
    cache.put(cacheKey, output.clone())
  );

  return output;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return asJson({
        ok: true,
        service: "Swarna Live",
        backend: "Cloudflare Worker",
        provider: "Unofficial IBJA API"
      });
    }

    if (url.pathname === "/api/rates") {
      if (request.method !== "GET") {
        return asJson({
          ok: false,
          error: "GET required"
        }, 405);
      }

      return rates(request, ctx);
    }

    if (url.pathname.startsWith("/api/")) {
      return asJson({
        ok: false,
        error: "Unknown API endpoint"
      }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
