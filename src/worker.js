// Cloudflare Worker entry point. Static files in public/ are served by
// Workers Static Assets; requests to /api/* come here.
import { createApp, SECURITY_HEADERS } from './app.js';

function d1(DB) {
  return {
    all: async (sql, ...p) => (await DB.prepare(sql).bind(...p).all()).results,
    get: async (sql, ...p) => (await DB.prepare(sql).bind(...p).first()) ?? null,
    run: async (sql, ...p) => {
      const r = await DB.prepare(sql).bind(...p).run();
      return { changes: r.meta.changes, lastId: r.meta.last_row_id };
    },
  };
}

function r2(BUCKET) {
  return {
    put: (key, data, contentType) => BUCKET.put(key, data, { httpMetadata: { contentType } }),
    get: async (key) => {
      const obj = await BUCKET.get(key);
      return obj && { body: obj.body, contentType: obj.httpMetadata?.contentType };
    },
    delete: (key) => BUCKET.delete(key),
  };
}

let handler;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
      out.headers.set('Strict-Transport-Security', 'max-age=31536000');
      return out;
    }
    if (!env.SETUP_CODE) {
      // Never run in production without a setup code: otherwise whoever finds the
      // site first could create the admin account.
      return Response.json({ error: 'Server is not configured (SETUP_CODE secret missing)' }, { status: 500 });
    }
    handler ??= createApp({ db: d1(env.DB), files: r2(env.FILES), secureCookies: true, setupCode: env.SETUP_CODE });
    const res = await handler(request, { ip: request.headers.get('CF-Connecting-IP') || 'unknown' });
    res.headers.set('Strict-Transport-Security', 'max-age=31536000');
    return res;
  },
};
