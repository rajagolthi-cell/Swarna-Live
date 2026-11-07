// Platform administration: provisioning additional businesses.
// Requires the PLATFORM_ADMIN_TOKEN secret as a Bearer token. If the secret is
// not set, these endpoints do not exist (404). See docs/OPERATIONS.md.

import type { Ctx } from '../context';
import { assertNotLimited, auditStmt, recordAttempt } from '../context';
import { randomToken, safeEqual, sha256 } from '../crypto';
import { HttpError, email, json, notFound, str } from '../http';
import type { Router } from '../router';

const INVITE_DAYS = 7;

async function requireAdmin(ctx: Ctx) {
  const expected = ctx.env.PLATFORM_ADMIN_TOKEN;
  if (!expected || expected.length < 32) throw notFound();
  const key = `admin:${ctx.ip}`;
  await assertNotLimited(ctx, key, 10, 3600_000, 'Too many attempts.');
  const got = (ctx.req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!got || !safeEqual(got, expected)) {
    await recordAttempt(ctx, key);
    throw new HttpError(401, 'Invalid admin token.', 'BAD_ADMIN_TOKEN');
  }
}

export function adminRoutes(r: Router) {
  r.get('/admin/businesses', async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.env.DB.prepare(
      `SELECT b.id, b.name, b.disabled, b.created_at, o.email AS owner_email FROM businesses b
       LEFT JOIN owner_accounts o ON o.business_id = b.id ORDER BY b.created_at LIMIT 500`,
    ).all();
    return json(rows.results);
  });

  /** Creates a business and a one-time owner invitation (valid 7 days). The link is shown once. */
  r.post('/admin/businesses', async (ctx) => {
    await requireAdmin(ctx);
    const name = str(ctx.body.name, 'Business name', { required: true, max: 120 })!;
    const ownerEmail = email(ctx.body.owner_email);
    const taken = await ctx.env.DB.prepare('SELECT 1 AS x FROM owner_accounts WHERE email = ?').bind(ownerEmail).first();
    if (taken) throw new HttpError(409, 'That email already owns a business.', 'EMAIL_TAKEN');
    const id = crypto.randomUUID();
    const token = randomToken(32);
    const db = ctx.env.DB;
    await db.batch([
      db.prepare('INSERT INTO businesses (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, ownerEmail, ctx.now, ctx.now),
      db.prepare('INSERT INTO business_invites (token_hash, business_id, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(await sha256(token), id, ownerEmail, ctx.now + INVITE_DAYS * 86400_000, ctx.now),
      auditStmt(ctx, { businessId: id, action: 'business.provisioned', staff: null, after: { name, owner_email: ownerEmail } }),
    ]);
    // Token is in the URL fragment so it never reaches server logs.
    return json({ business_id: id, invite_url: `${ctx.env.APP_ORIGIN}/setup/invite#${token}`, expires_in_days: INVITE_DAYS }, 201);
  });

  r.post('/admin/businesses/:id/disable', async (ctx) => {
    await requireAdmin(ctx);
    const db = ctx.env.DB;
    const [b] = await db.batch([
      db.prepare('UPDATE businesses SET disabled = 1, updated_at = ? WHERE id = ?').bind(ctx.now, ctx.params.id),
      db.prepare('DELETE FROM sessions WHERE business_id = ?').bind(ctx.params.id),
      auditStmt(ctx, { businessId: ctx.params.id, action: 'business.disabled', staff: null }),
    ]);
    if (b.meta.changes !== 1) throw notFound('Business not found.');
    return json({ ok: true });
  });

  r.post('/admin/businesses/:id/enable', async (ctx) => {
    await requireAdmin(ctx);
    const res = await ctx.env.DB.prepare('UPDATE businesses SET disabled = 0, updated_at = ? WHERE id = ?').bind(ctx.now, ctx.params.id).run();
    if (res.meta.changes !== 1) throw notFound('Business not found.');
    return json({ ok: true });
  });
}
