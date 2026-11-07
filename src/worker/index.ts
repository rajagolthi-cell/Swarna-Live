import type { Env, SyncMessage } from './env';
import type { Ctx } from './context';
import { HttpError, errorResponse, json } from './http';
import { Router } from './router';
import { authRoutes } from './routes/auth';
import { staffRoutes } from './routes/staff';
import { settingsRoutes } from './routes/settings';
import { quoteRoutes, cleanupAbandonedPhotos } from './routes/quotes';
import { googleRoutes } from './routes/google';
import { adminRoutes } from './routes/admin';
import { processJob, runDueJobs } from './google/sync';

const router = new Router();
router.get('/health', async (ctx) => {
  let db = 'ok';
  try { await ctx.env.DB.prepare('SELECT 1').first(); } catch { db = 'unavailable'; }
  return json({ status: db === 'ok' ? 'ok' : 'degraded', service: 'swarna-live', environment: ctx.env.APP_ENV, database: db, time: new Date(ctx.now).toISOString() }, db === 'ok' ? 200 : 503);
});
authRoutes(router);
staffRoutes(router);
settingsRoutes(router);
quoteRoutes(router);
googleRoutes(router);
adminRoutes(router);

export function securityHeaders(env: Env, isHtml: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (isHtml) {
    h['Content-Security-Policy'] = [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' blob: data:", "connect-src 'self'",
      "font-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ].join('; ');
  }
  if (env.COOKIE_SECURE !== 'false') h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) if (!out.headers.has(k) || k !== 'Content-Security-Policy') out.headers.set(k, v);
  return out;
}

export async function handleApi(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const ctx: Ctx = {
    req, env, exec, url, params: {}, body: {}, now: Date.now(),
    ip: req.headers.get('CF-Connecting-IP') || 'local',
  };
  try {
    if (!env.AUTH_PEPPER || env.AUTH_PEPPER.length < 32) {
      if (url.pathname !== '/api/health') throw new HttpError(503, 'Swarna Live is not configured yet (AUTH_PEPPER secret missing).', 'NOT_CONFIGURED');
    }
    // Cross-site writes are refused outright (CSRF defence in depth on top of the CSRF token).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.get('Origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request refused.', 'BAD_ORIGIN');
    }
    return await router.handle(ctx, url.pathname.slice('/api'.length) || '/');
  } catch (e) {
    return errorResponse(e);
  }
}

export async function runMaintenance(env: Env, now = Date.now()) {
  await runDueJobs(env, now, 25);
  await cleanupAbandonedPhotos(env, now, undefined, 50);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE at < ?').bind(now - 2 * 86400_000),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now),
  ]);
}

export default {
  async fetch(req, env, exec): Promise<Response> {
    const url = new URL(req.url);
    // Canonical hostname: e.g. swarnalive.com → https://www.swarnalive.com
    const redirectHosts = (env.REDIRECT_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (redirectHosts.includes(url.hostname.toLowerCase())) {
      return Response.redirect(`${env.APP_ORIGIN.replace(/\/$/, '')}${url.pathname}${url.search}`, 301);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // API responses are always JSON (or a file/redirect), never the app's HTML.
      return withHeaders(await handleApi(req, env, exec), securityHeaders(env, false));
    }
    const res = await env.ASSETS.fetch(req);
    const isHtml = (res.headers.get('content-type') || '').includes('text/html');
    // A missing script/style/image must be a real 404, not the app's HTML page.
    if (isHtml && /^\/assets\/|\.(js|css|png|jpe?g|svg|webp|ico|map|txt|json)$/i.test(url.pathname)) {
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders(env, false) } });
    }
    const out = withHeaders(res, securityHeaders(env, isHtml));
    if (isHtml) out.headers.set('Cache-Control', 'no-cache');
    return out;
  },

  async scheduled(_event, env, exec) {
    exec.waitUntil(runMaintenance(env));
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        await processJob(env, msg.body.jobId);
        msg.ack();
      } catch {
        msg.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, SyncMessage>;
