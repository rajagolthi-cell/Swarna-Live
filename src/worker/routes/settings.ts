import type { Ctx } from '../context';
import { auditStmt, can, checkCsrf, requireBusiness, requireOwner, requirePerm, requireStaff } from '../context';
import { bad, forbidden, intParam, json, notFound, str } from '../http';
import type { Router } from '../router';
import { MAX_RATE_PAISE, parsePercentToBp, parseRupeesToPaise, type Metal } from '../../shared/calc';
import { sniffImage } from '../image';

export interface BusinessRow {
  id: string; name: string; phone: string | null; email: string | null; address: string | null; gstin: string | null;
  logo_key: string | null; logo_type: string | null;
  default_pct_bp: number; staff_min_pct_bp: number; staff_max_pct_bp: number;
  profile_lock_minutes: number; session_hours: number; updated_at: number;
}

export interface RateRow { id: string; metal: Metal; rate_paise: number; created_by_name: string; created_at: number }

export async function loadBusiness(ctx: Ctx): Promise<BusinessRow> {
  const b = await ctx.env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(ctx.session!.business_id).first<BusinessRow>();
  if (!b) throw notFound();
  return b;
}

export async function currentRates(ctx: Ctx, businessId: string): Promise<Record<Metal, RateRow | null>> {
  const q = ctx.env.DB.prepare(
    'SELECT id, metal, rate_paise, created_by_name, created_at FROM rate_versions WHERE business_id = ? AND metal = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  );
  const [g, s] = await ctx.env.DB.batch<RateRow>([q.bind(businessId, 'gold'), q.bind(businessId, 'silver')]);
  return { gold: g.results[0] ?? null, silver: s.results[0] ?? null };
}

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_LOGO_BYTES = 1024 * 1024;

export function settingsRoutes(r: Router) {
  r.get('/settings', async (ctx) => {
    const st = await requireStaff(ctx);
    const b = await loadBusiness(ctx);
    const isOwner = st.role === 'owner';
    return json({
      business: { name: b.name, phone: b.phone, email: b.email, address: b.address, gstin: b.gstin, has_logo: !!b.logo_key },
      buyback: { default_pct_bp: b.default_pct_bp, staff_min_pct_bp: b.staff_min_pct_bp, staff_max_pct_bp: b.staff_max_pct_bp },
      ...(isOwner ? { security: { profile_lock_minutes: b.profile_lock_minutes, session_hours: b.session_hours } } : {}),
    });
  });

  r.put('/settings/business', async (ctx) => {
    await requirePerm(ctx, 'settings.business');
    checkCsrf(ctx);
    const b = await loadBusiness(ctx);
    const after = {
      name: str(ctx.body.name, 'Business name', { required: true, max: 120 })!,
      phone: str(ctx.body.phone, 'Phone', { max: 40 }),
      email: str(ctx.body.email, 'Email', { max: 120 }),
      address: str(ctx.body.address, 'Address', { max: 400 }),
      gstin: str(ctx.body.gstin, 'GSTIN', { max: 20 }),
    };
    const before = { name: b.name, phone: b.phone, email: b.email, address: b.address, gstin: b.gstin };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE businesses SET name = ?, phone = ?, email = ?, address = ?, gstin = ?, updated_at = ? WHERE id = ?')
        .bind(after.name, after.phone, after.email, after.address, after.gstin, ctx.now, b.id),
      auditStmt(ctx, { businessId: b.id, action: 'settings.business', before, after }),
    ]);
    return json({ ok: true });
  });

  r.put('/settings/buyback', async (ctx) => {
    await requireOwner(ctx);
    checkCsrf(ctx);
    const b = await loadBusiness(ctx);
    const pct = (v: unknown, label: string) => {
      const bp = parsePercentToBp(v as string);
      if (bp === null || bp <= 0 || bp > 10000) throw bad(`${label} must be more than 0 and at most 100.`);
      return bp;
    };
    const after = {
      default_pct_bp: pct(ctx.body.default_pct, 'Default buyback percentage'),
      staff_min_pct_bp: pct(ctx.body.staff_min_pct, 'Staff minimum'),
      staff_max_pct_bp: pct(ctx.body.staff_max_pct, 'Staff maximum'),
    };
    if (after.staff_min_pct_bp > after.staff_max_pct_bp) throw bad('Staff minimum cannot be above the staff maximum.');
    if (after.default_pct_bp < after.staff_min_pct_bp || after.default_pct_bp > after.staff_max_pct_bp) {
      throw bad('The default percentage must be inside the staff limits, so staff can use it.');
    }
    const before = { default_pct_bp: b.default_pct_bp, staff_min_pct_bp: b.staff_min_pct_bp, staff_max_pct_bp: b.staff_max_pct_bp };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE businesses SET default_pct_bp = ?, staff_min_pct_bp = ?, staff_max_pct_bp = ?, updated_at = ? WHERE id = ?')
        .bind(after.default_pct_bp, after.staff_min_pct_bp, after.staff_max_pct_bp, ctx.now, b.id),
      auditStmt(ctx, { businessId: b.id, action: 'settings.buyback', before, after }),
    ]);
    return json({ ok: true });
  });

  r.put('/settings/security', async (ctx) => {
    await requireOwner(ctx);
    checkCsrf(ctx);
    const b = await loadBusiness(ctx);
    const lock = Number(ctx.body.profile_lock_minutes);
    const hours = Number(ctx.body.session_hours);
    if (!Number.isInteger(lock) || lock < 1 || lock > 240) throw bad('Profile lock must be between 1 and 240 minutes.');
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw bad('Business sign-in must last between 1 and 72 hours.');
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE businesses SET profile_lock_minutes = ?, session_hours = ?, updated_at = ? WHERE id = ?').bind(lock, hours, ctx.now, b.id),
      auditStmt(ctx, { businessId: b.id, action: 'settings.security', before: { profile_lock_minutes: b.profile_lock_minutes, session_hours: b.session_hours }, after: { profile_lock_minutes: lock, session_hours: hours } }),
    ]);
    return json({ ok: true });
  });

  // ---- logo (private R2; served only to signed-in users of this business) ----
  r.get('/settings/logo', async (ctx) => {
    const s = await requireBusiness(ctx);
    const b = await ctx.env.DB.prepare('SELECT logo_key, logo_type FROM businesses WHERE id = ?').bind(s.business_id).first<{ logo_key: string | null; logo_type: string }>();
    if (!b?.logo_key) throw notFound('No logo.');
    const obj = await ctx.env.PHOTOS.get(b.logo_key);
    if (!obj) throw notFound('No logo.');
    return new Response(obj.body, { headers: { 'Content-Type': b.logo_type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
  });

  r.post('/settings/logo', async (ctx) => {
    await requirePerm(ctx, 'settings.business');
    checkCsrf(ctx);
    const b = await loadBusiness(ctx);
    const type = (ctx.req.headers.get('content-type') || '').split(';')[0].trim();
    if (!LOGO_TYPES.includes(type)) throw bad('Logo must be a PNG, JPEG or WEBP image.');
    const buf = new Uint8Array(await ctx.req.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_LOGO_BYTES) throw bad('Logo must be smaller than 1 MB.');
    const info = sniffImage(buf);
    if (!info || info.type !== type || info.width < 32 || info.height < 32 || info.width > 4000 || info.height > 4000) {
      throw bad('That file is not a valid logo image (32–4000 pixels).');
    }
    const key = `b/${b.id}/logo/${crypto.randomUUID()}`;
    await ctx.env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type } });
    try {
      await ctx.env.DB.batch([
        ctx.env.DB.prepare('UPDATE businesses SET logo_key = ?, logo_type = ?, updated_at = ? WHERE id = ?').bind(key, type, ctx.now, b.id),
        auditStmt(ctx, { businessId: b.id, action: 'settings.logo_changed' }),
      ]);
    } catch (e) {
      await ctx.env.PHOTOS.delete(key); // database did not take it: remove the new object
      throw e;
    }
    if (b.logo_key) await ctx.env.PHOTOS.delete(b.logo_key).catch(() => undefined); // old logo is no longer referenced
    return json({ ok: true });
  }, { rawBody: true });

  r.delete('/settings/logo', async (ctx) => {
    await requirePerm(ctx, 'settings.business');
    checkCsrf(ctx);
    const b = await loadBusiness(ctx);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE businesses SET logo_key = NULL, logo_type = NULL, updated_at = ? WHERE id = ?').bind(ctx.now, b.id),
      auditStmt(ctx, { businessId: b.id, action: 'settings.logo_removed' }),
    ]);
    if (b.logo_key) await ctx.env.PHOTOS.delete(b.logo_key).catch(() => undefined);
    return json({ ok: true });
  });

  // ---- business-entered rates ----
  r.get('/rates', async (ctx) => {
    await requireStaff(ctx);
    const rates = await currentRates(ctx, ctx.session!.business_id);
    return json({ gold: rates.gold, silver: rates.silver });
  });

  r.post('/rates', async (ctx) => {
    const st = await requirePerm(ctx, 'rates.update');
    checkCsrf(ctx);
    const s = ctx.session!;
    const metal = ctx.body.metal;
    if (metal !== 'gold' && metal !== 'silver') throw bad('Choose gold or silver.');
    const paise = parseRupeesToPaise(ctx.body.rate as string);
    if (paise === null || paise <= 0 || paise > MAX_RATE_PAISE) throw bad('Enter a rate per gram greater than ₹0 (up to 2 decimals).');
    const prev = (await currentRates(ctx, s.business_id))[metal];
    const id = crypto.randomUUID();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('INSERT INTO rate_versions (id, business_id, metal, rate_paise, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, s.business_id, metal, paise, st.id, st.name, ctx.now),
      auditStmt(ctx, { businessId: s.business_id, action: 'rates.updated', entityType: 'rate', entityId: id,
        before: prev ? { metal, rate_paise: prev.rate_paise, version: prev.id } : null, after: { metal, rate_paise: paise, version: id } }),
    ]);
    return json({ id, metal, rate_paise: paise, created_at: ctx.now, created_by_name: st.name }, 201);
  });

  r.get('/rates/history', async (ctx) => {
    const st = await requireStaff(ctx);
    if (!can(st, 'rates.update') && !can(st, 'audit.view')) throw forbidden();
    const page = intParam(ctx.url.searchParams.get('page'), 1, 1, 1000);
    const metal = ctx.url.searchParams.get('metal');
    const m = metal === 'gold' || metal === 'silver' ? metal : null;
    const rows = await ctx.env.DB.prepare(
      `SELECT id, metal, rate_paise, created_by_name, created_at FROM rate_versions
       WHERE business_id = ? AND (?2 IS NULL OR metal = ?2) ORDER BY created_at DESC, rowid DESC LIMIT 26 OFFSET ?`,
    ).bind(ctx.session!.business_id, m, (page - 1) * 25).all<RateRow>();
    return json({ items: rows.results.slice(0, 25), has_more: rows.results.length > 25, page });
  });

  // ---- audit history ----
  r.get('/audit', async (ctx) => {
    await requirePerm(ctx, 'audit.view');
    const page = intParam(ctx.url.searchParams.get('page'), 1, 1, 10000);
    const rows = await ctx.env.DB.prepare(
      `SELECT id, staff_name, action, entity_type, entity_id, reason, before_json, after_json, created_at
       FROM audit_log WHERE business_id = ? ORDER BY created_at DESC LIMIT 51 OFFSET ?`,
    ).bind(ctx.session!.business_id, (page - 1) * 50).all();
    return json({ items: rows.results.slice(0, 50), has_more: rows.results.length > 50, page });
  });

}
