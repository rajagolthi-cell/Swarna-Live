import type { ActiveStaff, Ctx } from '../context';
import { auditStmt, can, checkCsrf, requirePerm, requireStaff } from '../context';
import { HttpError, bad, intParam, json, notFound, phone, str } from '../http';
import type { Router } from '../router';
import {
  CALC_ERROR_TEXT, ITEM_TYPES, computeQuote, karatOf, parseGramsToMg, parsePercentToBp, purityAllowed, validateQuote,
  formatBp, mgToGramsString, paiseToRupeesString, type Metal,
} from '../../shared/calc';
import { STATUSES, type QuoteStatus } from '../../shared/permissions';
import { DAY_MS, formatIST, istDayStart, istParts } from '../../shared/time';
import { currentRates, loadBusiness } from './settings';
import { sniffImage } from '../image';
import { csvRow } from '../csv';
import { dispatchJobsForQuote, markSheetDirtyStmt, newJobStatements } from '../google/sync';

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_MIN_SIDE = 480;
export const PHOTO_MAX_SIDE = 4096;
/** Photos that never got attached to a quote are removed after this long. */
export const PHOTO_ABANDON_MS = 6 * 3600_000;

export interface QuoteRow {
  id: string; business_id: string; order_no: string; order_year: number; order_seq: number; idempotency_key: string; draft_ref: string;
  staff_id: string; staff_name: string; customer_name: string; customer_phone: string; metal: Metal; item_type: string;
  description: string | null; purity: string; gross_mg: number; deduction_mg: number; net_mg: number;
  rate_version_id: string; base_rate_paise: number; applied_rate_paise: number; assessed_paise: number; pct_bp: number; offer_paise: number;
  pct_override: number; override_reason: string | null; notes: string | null; status: QuoteStatus; photo_id: string;
  original_json: string; created_at: number; updated_at: number;
}

function canSeeQuote(st: ActiveStaff, q: Pick<QuoteRow, 'staff_id'>) {
  return can(st, 'quotes.view_all') || q.staff_id === st.id;
}

async function loadQuote(ctx: Ctx, st: ActiveStaff, id: string): Promise<QuoteRow> {
  const q = await ctx.env.DB.prepare('SELECT * FROM quotes WHERE id = ? AND business_id = ?').bind(id, ctx.session!.business_id).first<QuoteRow>();
  // Same response whether it does not exist or belongs to someone the user may not see.
  if (!q || !canSeeQuote(st, q)) throw notFound('Transaction not found.');
  return q;
}

/** Remove photos that were uploaded but never attached to a saved quote. Never touches attached photos. */
export async function cleanupAbandonedPhotos(env: Ctx['env'], now: number, businessId?: string, limit = 20) {
  const rows = await env.DB.prepare(
    `SELECT id, r2_key, business_id FROM photos WHERE state IN ('uploading','pending') AND created_at < ?
     AND (?2 IS NULL OR business_id = ?2) LIMIT ?`,
  ).bind(now - PHOTO_ABANDON_MS, businessId ?? null, limit).all<{ id: string; r2_key: string; business_id: string }>();
  let removed = 0;
  for (const p of rows.results) {
    // Conditional delete: if a quote attached it in the meantime, state is 'attached' and nothing happens.
    const del = await env.DB.prepare(`DELETE FROM photos WHERE id = ? AND state IN ('uploading','pending')
                                      AND NOT EXISTS (SELECT 1 FROM quotes WHERE photo_id = photos.id)`).bind(p.id).run();
    if (del.meta.changes === 1) {
      await env.PHOTOS.delete(p.r2_key);
      removed++;
    }
  }
  return removed;
}

function quoteView(q: QuoteRow) {
  const { original_json: _o, idempotency_key: _k, business_id: _b, ...rest } = q;
  return { ...rest, photo_url: `/api/photos/${q.photo_id}` };
}

function listFilters(ctx: Ctx, st: ActiveStaff) {
  const p = ctx.url.searchParams;
  const where = ['business_id = ?'];
  const args: (string | number)[] = [ctx.session!.business_id];
  if (!can(st, 'quotes.view_all')) { where.push('staff_id = ?'); args.push(st.id); }
  const q = (p.get('q') || '').trim().slice(0, 60);
  if (q) {
    const digits = q.replace(/\D/g, '');
    if (/^\d{2}-\d+$/.test(q)) { where.push('order_no = ?'); args.push(q); }
    else {
      const ors = ['customer_name LIKE ?', 'order_no LIKE ?'];
      args.push(`%${q}%`, `%${q}%`);
      if (digits.length >= 4) { ors.push('customer_phone LIKE ?'); args.push(`%${digits}%`); }
      where.push(`(${ors.join(' OR ')})`);
    }
  }
  const status = p.get('status');
  if (status && (STATUSES as readonly string[]).includes(status)) { where.push('status = ?'); args.push(status); }
  const from = p.get('from') ? istDayStart(p.get('from')!) : null;
  const to = p.get('to') ? istDayStart(p.get('to')!) : null;
  if (p.get('from') && from === null) throw bad('From date is invalid.');
  if (p.get('to') && to === null) throw bad('To date is invalid.');
  if (from !== null) { where.push('created_at >= ?'); args.push(from); }
  if (to !== null) { where.push('created_at < ?'); args.push(to + DAY_MS); }
  return { where: where.join(' AND '), args };
}

const CORRECTABLE = ['customer_name', 'customer_phone', 'item_type', 'description', 'notes'] as const;

export function quoteRoutes(r: Router) {
  // ---- photographs ----
  r.post('/photos', async (ctx) => {
    const st = await requirePerm(ctx, 'quotes.create');
    checkCsrf(ctx);
    const businessId = ctx.session!.business_id;
    const type = (ctx.req.headers.get('content-type') || '').split(';')[0].trim();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw bad('Photo must be a JPEG, PNG or WEBP image.', 'PHOTO_TYPE');
    const declared = Number(ctx.req.headers.get('content-length') || 0);
    if (declared > PHOTO_MAX_BYTES) throw new HttpError(413, 'Photo is too large (maximum 5 MB).', 'PHOTO_TOO_LARGE');
    const buf = new Uint8Array(await ctx.req.arrayBuffer());
    if (buf.length > PHOTO_MAX_BYTES) throw new HttpError(413, 'Photo is too large (maximum 5 MB).', 'PHOTO_TOO_LARGE');
    const info = sniffImage(buf);
    if (!info || info.type !== type) throw bad('That file is not a valid photo.', 'PHOTO_INVALID');
    if (Math.min(info.width, info.height) < PHOTO_MIN_SIDE || Math.max(info.width, info.height) > PHOTO_MAX_SIDE) {
      throw bad(`Photo must be at least ${PHOTO_MIN_SIDE} pixels on its short side and at most ${PHOTO_MAX_SIDE} pixels.`, 'PHOTO_DIMENSIONS');
    }
    const id = crypto.randomUUID();
    const { year, month } = istParts(ctx.now);
    const key = `b/${businessId}/photos/${year}/${String(month).padStart(2, '0')}/${id}.${info.type.split('/')[1]}`;
    const db = ctx.env.DB;
    // 1) record the upload first, so a failure at any later step leaves something the cleanup can find
    await db.prepare(`INSERT INTO photos (id, business_id, r2_key, state, content_type, size, width, height, uploaded_by, created_at)
                      VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?)`)
      .bind(id, businessId, key, info.type, buf.length, info.width, info.height, st.id, ctx.now).run();
    // 2) store the bytes privately in R2
    try {
      await ctx.env.PHOTOS.put(key, buf, { httpMetadata: { contentType: info.type }, customMetadata: { business: businessId, photo: id } });
    } catch {
      await db.prepare("DELETE FROM photos WHERE id = ? AND state = 'uploading'").bind(id).run().catch(() => undefined);
      throw new HttpError(503, 'The photo could not be stored. Please try again.', 'PHOTO_STORE_FAILED');
    }
    // 3) mark it ready to attach
    await db.prepare("UPDATE photos SET state = 'pending' WHERE id = ? AND state = 'uploading'").bind(id).run();
    ctx.exec.waitUntil(cleanupAbandonedPhotos(ctx.env, ctx.now, businessId, 10).catch(() => 0));
    return json({ id, width: info.width, height: info.height, size: buf.length }, 201);
  }, { rawBody: true });

  r.get('/photos/:id', async (ctx) => {
    const st = await requireStaff(ctx);
    const p = await ctx.env.DB.prepare(
      `SELECT p.*, q.staff_id AS quote_staff_id FROM photos p LEFT JOIN quotes q ON q.photo_id = p.id AND q.business_id = p.business_id
       WHERE p.id = ? AND p.business_id = ?`,
    ).bind(ctx.params.id, ctx.session!.business_id).first<{ r2_key: string; state: string; content_type: string; uploaded_by: string; quote_staff_id: string | null }>();
    const allowed = p && (p.state === 'attached'
      ? p.quote_staff_id !== null && canSeeQuote(st, { staff_id: p.quote_staff_id })
      : p.uploaded_by === st.id);
    if (!p || !allowed) throw notFound('Photo not found.');
    const obj = await ctx.env.PHOTOS.get(p.r2_key);
    if (!obj) throw notFound('Photo not found.');
    return new Response(obj.body, {
      headers: {
        'Content-Type': p.content_type, 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline',
      },
    });
  });

  // ---- create a buyback estimate ----
  r.post('/quotes', async (ctx) => {
    const st = await requirePerm(ctx, 'quotes.create');
    checkCsrf(ctx);
    const businessId = ctx.session!.business_id;
    const b = ctx.body;
    const db = ctx.env.DB;

    const idem = typeof b.idempotency_key === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(b.idempotency_key) ? b.idempotency_key : null;
    if (!idem) throw bad('Missing submission key. Refresh the page and try again.');
    const existing = await db.prepare('SELECT * FROM quotes WHERE business_id = ? AND idempotency_key = ?').bind(businessId, idem).first<QuoteRow>();
    if (existing) {
      if (existing.staff_id !== st.id) throw new HttpError(409, 'This submission was already used.', 'DUPLICATE');
      return json({ quote: quoteView(existing), duplicate: true }, 200);
    }

    const metal = b.metal;
    if (metal !== 'gold' && metal !== 'silver') throw bad('Choose Gold or Silver.');
    const purity = typeof b.purity === 'string' ? b.purity : '';
    if (!purityAllowed(metal, purity)) throw bad(CALC_ERROR_TEXT.PURITY_INVALID, 'PURITY_INVALID');
    const itemType = str(b.item_type, 'Item type', { required: true, max: 40 })!;
    if (!(ITEM_TYPES as readonly string[]).includes(itemType)) throw bad('Choose an item type from the list.');
    const customerName = str(b.customer_name, 'Customer name', { required: true, max: 100 })!;
    const customerPhone = phone(b.customer_phone);
    const description = str(b.description, 'Item description', { max: 500 });
    const notes = str(b.notes, 'Notes', { max: 1000 });
    const grossMg = parseGramsToMg(b.gross_weight as string);
    const deductionMg = b.deduction_weight === '' || b.deduction_weight == null ? 0 : parseGramsToMg(b.deduction_weight as string);
    if (grossMg === null) throw bad(CALC_ERROR_TEXT.GROSS_INVALID, 'GROSS_INVALID');
    if (deductionMg === null) throw bad(CALC_ERROR_TEXT.DEDUCTION_INVALID, 'DEDUCTION_INVALID');
    const pctBp = parsePercentToBp(b.buyback_pct as string);
    if (pctBp === null) throw bad(CALC_ERROR_TEXT.PERCENT_INVALID, 'PERCENT_INVALID');

    const business = await loadBusiness(ctx);
    const rate = (await currentRates(ctx, businessId))[metal];
    if (!rate || rate.rate_paise <= 0) {
      throw new HttpError(422, `No ${metal} rate has been entered. Ask the owner to set today’s business-entered ${metal} rate.`, 'RATE_MISSING');
    }
    const calcErr = validateQuote({ metal, purity, grossMg, deductionMg, baseRatePaise: rate.rate_paise, pctBp });
    if (calcErr) throw bad(CALC_ERROR_TEXT[calcErr], calcErr);

    // Percentage limits: staff must stay inside the owner's limits; the owner may go outside with a reason.
    const outside = pctBp < business.staff_min_pct_bp || pctBp > business.staff_max_pct_bp;
    let overrideReason: string | null = null;
    if (outside) {
      if (st.role !== 'owner') {
        throw new HttpError(403, `Buyback percentage must be between ${formatBp(business.staff_min_pct_bp)} and ${formatBp(business.staff_max_pct_bp)}. Ask the owner for a higher or lower percentage.`, 'PERCENT_LIMIT');
      }
      overrideReason = str(b.override_reason, 'Override reason', { max: 300 });
      if (!overrideReason) throw bad('Give a reason for using a percentage outside the staff limits.', 'OVERRIDE_REASON_REQUIRED');
    }

    const figures = computeQuote({ metal, purity, grossMg, deductionMg, baseRatePaise: rate.rate_paise, pctBp });
    const preview = {
      rate_version_id: rate.id, base_rate_paise: rate.rate_paise, applied_rate_paise: figures.appliedRatePaise,
      net_mg: figures.netMg, assessed_paise: figures.assessedPaise, offer_paise: figures.offerPaise, pct_bp: pctBp,
      rate_updated_at: rate.created_at, rate_updated_by: rate.created_by_name,
    };
    // The rate the user saw must be the current one, and the offer they saw must match ours exactly.
    if (b.rate_version_id !== rate.id) {
      throw new HttpError(409, `The ${metal} rate was changed while you were preparing this quote. Please review the updated offer before saving.`, 'RATE_CHANGED', { current: preview });
    }
    if (Number(b.expected_offer_paise) !== figures.offerPaise) {
      throw new HttpError(409, 'The offer shown on your screen does not match. Please review the updated offer before saving.', 'OFFER_MISMATCH', { current: preview });
    }

    const photoId = typeof b.photo_id === 'string' ? b.photo_id : '';
    const photo = photoId && await db.prepare(
      "SELECT id FROM photos WHERE id = ? AND business_id = ? AND state = 'pending' AND uploaded_by = ?",
    ).bind(photoId, businessId, st.id).first();
    if (!photo) throw new HttpError(422, 'A photograph of the jewellery with the scale reading is required. Please take or upload the photo again.', 'PHOTO_REQUIRED');

    const draftRef = typeof b.draft_ref === 'string' && /^[A-Z0-9]{6,10}$/.test(b.draft_ref) ? b.draft_ref : idem.replace(/-/g, '').slice(0, 8).toUpperCase();
    const id = crypto.randomUUID();
    const { year } = istParts(ctx.now);
    const yy = year % 100;
    const record = {
      id, staff_id: st.id, staff_name: st.name, customer_name: customerName, customer_phone: customerPhone, metal, item_type: itemType,
      description, purity, karat: karatOf(purity), gross_mg: grossMg, deduction_mg: deductionMg, net_mg: figures.netMg,
      rate_version_id: rate.id, base_rate_paise: rate.rate_paise, applied_rate_paise: figures.appliedRatePaise,
      assessed_paise: figures.assessedPaise, pct_bp: pctBp, offer_paise: figures.offerPaise, pct_override: outside ? 1 : 0,
      override_reason: overrideReason, notes, status: 'estimated', photo_id: photoId, created_at: ctx.now,
    };

    // One D1 batch = one transaction: counter, quote, photo attachment, audit and sync jobs all succeed or none do.
    const stmts: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO order_counters (business_id, year, last_seq) VALUES (?, ?, 1)
                  ON CONFLICT (business_id, year) DO UPDATE SET last_seq = last_seq + 1`).bind(businessId, year),
      db.prepare(`INSERT INTO quotes (id, business_id, order_no, order_year, order_seq, idempotency_key, draft_ref, staff_id, staff_name,
                    customer_name, customer_phone, metal, item_type, description, purity, gross_mg, deduction_mg, net_mg,
                    rate_version_id, base_rate_paise, applied_rate_paise, assessed_paise, pct_bp, offer_paise, pct_override, override_reason,
                    notes, status, photo_id, original_json, created_at, updated_at)
                  SELECT ?, ?, printf('%02d-%04d', ?, c.last_seq), ?, c.last_seq, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'estimated', ?, ?, ?, ?
                  FROM order_counters c WHERE c.business_id = ? AND c.year = ?`)
        .bind(id, businessId, yy, year, idem, draftRef, st.id, st.name, customerName, customerPhone, metal, itemType, description, purity,
          grossMg, deductionMg, figures.netMg, rate.id, rate.rate_paise, figures.appliedRatePaise, figures.assessedPaise, pctBp, figures.offerPaise,
          outside ? 1 : 0, overrideReason, notes, photoId, JSON.stringify(record), ctx.now, ctx.now, businessId, year),
      db.prepare(`UPDATE photos SET state = 'attached' WHERE id = ? AND business_id = ? AND state = 'pending'
                  AND EXISTS (SELECT 1 FROM quotes WHERE id = ? AND photo_id = ?)`).bind(photoId, businessId, id, photoId),
      auditStmt(ctx, { businessId, action: 'quote.created', entityType: 'quote', entityId: id, after: { offer_paise: figures.offerPaise, pct_bp: pctBp, rate_version_id: rate.id } }),
      ...(outside ? [auditStmt(ctx, { businessId, action: 'quote.percentage_override', entityType: 'quote', entityId: id, reason: overrideReason,
        before: { staff_min_pct_bp: business.staff_min_pct_bp, staff_max_pct_bp: business.staff_max_pct_bp }, after: { pct_bp: pctBp } })] : []),
      ...newJobStatements(ctx.env, businessId, id, ctx.now),
    ];
    let results: D1Result[];
    try {
      results = await db.batch(stmts);
    } catch (e) {
      const again = await db.prepare('SELECT * FROM quotes WHERE business_id = ? AND idempotency_key = ?').bind(businessId, idem).first<QuoteRow>();
      if (again && again.staff_id === st.id) return json({ quote: quoteView(again), duplicate: true }, 200); // concurrent double-submit
      const msg = e instanceof Error ? e.message : '';
      if (/photo_id|FOREIGN KEY/i.test(msg)) throw new HttpError(409, 'This photo can no longer be used. Please take the photo again.', 'PHOTO_REQUIRED');
      throw new HttpError(503, 'The quote was not saved. Please try again.', 'SAVE_FAILED');
    }
    if (results[2].meta.changes !== 1) {
      // Should be impossible inside the transaction, but never report success without the photo attached.
      throw new HttpError(500, 'The quote was not saved correctly. Please try again.', 'SAVE_FAILED');
    }
    const saved = (await db.prepare('SELECT * FROM quotes WHERE id = ? AND business_id = ?').bind(id, businessId).first<QuoteRow>())!;
    ctx.exec.waitUntil(dispatchJobsForQuote(ctx.env, businessId, id).catch(() => undefined));
    return json({ quote: quoteView(saved), duplicate: false }, 201);
  });

  // ---- list / search ----
  r.get('/quotes', async (ctx) => {
    const st = await requireStaff(ctx);
    const { where, args } = listFilters(ctx, st);
    const pageSize = intParam(ctx.url.searchParams.get('page_size'), 20, 5, 50);
    const page = intParam(ctx.url.searchParams.get('page'), 1, 1, 100000);
    const db = ctx.env.DB;
    const [rows, count] = await db.batch([
      db.prepare(`SELECT id, order_no, created_at, staff_name, customer_name, customer_phone, metal, purity, item_type, net_mg, offer_paise, status
                  FROM quotes WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...args, pageSize, (page - 1) * pageSize),
      db.prepare(`SELECT COUNT(*) AS n FROM quotes WHERE ${where}`).bind(...args),
    ]);
    const total = (count.results[0] as { n: number }).n;
    return json({ items: rows.results, page, page_size: pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) });
  });

  r.get('/quotes/export.csv', async (ctx) => {
    const st = await requirePerm(ctx, 'quotes.export');
    const { where, args } = listFilters(ctx, st);
    const rows = await ctx.env.DB.prepare(`SELECT * FROM quotes WHERE ${where} ORDER BY created_at DESC LIMIT 5001`).bind(...args).all<QuoteRow>();
    if (rows.results.length > 5000) throw bad('More than 5,000 transactions match. Narrow the date range and export in parts.', 'EXPORT_TOO_LARGE');
    let out = '﻿' + csvRow(['Order Number', 'Date/Time IST', 'Staff Name', 'Customer Name', 'Phone Number', 'Metal', 'Item Type', 'Description',
      'Purity', 'Gross Weight (g)', 'Deduction (g)', 'Net Weight (g)', 'Rate Per Gram (INR)', 'Assessed Value (INR)', 'Buyback Percentage',
      'Estimated Offer (INR)', 'Status', 'Notes']);
    for (const q of rows.results) {
      out += csvRow([q.order_no, formatIST(q.created_at), q.staff_name, q.customer_name, q.customer_phone, q.metal === 'gold' ? 'Gold' : 'Silver',
        q.item_type, q.description, q.purity, mgToGramsString(q.gross_mg), mgToGramsString(q.deduction_mg), mgToGramsString(q.net_mg),
        paiseToRupeesString(q.applied_rate_paise), paiseToRupeesString(q.assessed_paise), q.pct_bp / 100, paiseToRupeesString(q.offer_paise),
        q.status[0].toUpperCase() + q.status.slice(1), q.notes]);
    }
    await auditStmt(ctx, { businessId: ctx.session!.business_id, action: 'quotes.exported', after: { rows: rows.results.length } }).run();
    return new Response(out, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="swarna-live-transactions.csv"', 'Cache-Control': 'no-store' },
    });
  });

  r.get('/quotes/:id', async (ctx) => {
    const st = await requireStaff(ctx);
    const q = await loadQuote(ctx, st, ctx.params.id);
    const db = ctx.env.DB;
    const [audit, jobs] = await db.batch([
      db.prepare(`SELECT staff_name, action, reason, before_json, after_json, created_at FROM audit_log
                  WHERE business_id = ? AND entity_type = 'quote' AND entity_id = ? ORDER BY created_at LIMIT 200`).bind(q.business_id, q.id),
      db.prepare('SELECT kind, status, attempts, last_error, drive_link, synced_at FROM sync_jobs WHERE business_id = ? AND quote_id = ?').bind(q.business_id, q.id),
    ]);
    return json({
      quote: quoteView(q),
      original: JSON.parse(q.original_json),
      audit: audit.results,
      backup: st.role === 'owner' ? jobs.results : undefined,
    });
  });

  r.post('/quotes/:id/status', async (ctx) => {
    const st = await requirePerm(ctx, 'quotes.update_status');
    checkCsrf(ctx);
    const q = await loadQuote(ctx, st, ctx.params.id);
    const status = ctx.body.status as QuoteStatus;
    if (!(STATUSES as readonly string[]).includes(status)) throw bad('Choose a valid status.');
    if (status === q.status) throw bad('The quote already has this status.');
    const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 })!;
    const db = ctx.env.DB;
    const [upd] = await db.batch([
      db.prepare('UPDATE quotes SET status = ?, updated_at = ? WHERE id = ? AND business_id = ? AND status = ?').bind(status, ctx.now, q.id, q.business_id, q.status),
      auditStmt(ctx, { businessId: q.business_id, action: 'quote.status_changed', entityType: 'quote', entityId: q.id, reason, before: { status: q.status }, after: { status } }),
      markSheetDirtyStmt(ctx.env, q.business_id, q.id, ctx.now),
    ]);
    if (upd.meta.changes !== 1) throw new HttpError(409, 'Someone else changed this quote. Refresh and try again.', 'CONFLICT');
    ctx.exec.waitUntil(dispatchJobsForQuote(ctx.env, q.business_id, q.id).catch(() => undefined));
    return json({ ok: true });
  });

  /** Correct descriptive details. Weights, rate, percentage and offer can never be changed: cancel and create a new quote instead. */
  r.post('/quotes/:id/correct', async (ctx) => {
    const st = await requirePerm(ctx, 'quotes.correct');
    checkCsrf(ctx);
    const q = await loadQuote(ctx, st, ctx.params.id);
    const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 })!;
    const next: Record<string, string | null> = {};
    for (const f of CORRECTABLE) {
      if (!(f in ctx.body)) continue;
      if (f === 'customer_phone') next[f] = phone(ctx.body[f]);
      else if (f === 'customer_name') next[f] = str(ctx.body[f], 'Customer name', { required: true, max: 100 });
      else if (f === 'item_type') {
        const v = str(ctx.body[f], 'Item type', { required: true, max: 40 })!;
        if (!(ITEM_TYPES as readonly string[]).includes(v)) throw bad('Choose an item type from the list.');
        next[f] = v;
      } else next[f] = str(ctx.body[f], f === 'notes' ? 'Notes' : 'Description', { max: f === 'notes' ? 1000 : 500 });
    }
    const changed = Object.keys(next).filter((k) => next[k] !== (q as unknown as Record<string, unknown>)[k]);
    if (!changed.length) throw bad('Nothing was changed.');
    const before = Object.fromEntries(changed.map((k) => [k, (q as unknown as Record<string, unknown>)[k]]));
    const after = Object.fromEntries(changed.map((k) => [k, next[k]]));
    const db = ctx.env.DB;
    const [upd] = await db.batch([
      db.prepare(`UPDATE quotes SET ${changed.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND business_id = ? AND updated_at = ?`)
        .bind(...changed.map((k) => next[k]), ctx.now, q.id, q.business_id, q.updated_at),
      auditStmt(ctx, { businessId: q.business_id, action: 'quote.corrected', entityType: 'quote', entityId: q.id, reason, before, after }),
      markSheetDirtyStmt(ctx.env, q.business_id, q.id, ctx.now),
    ]);
    if (upd.meta.changes !== 1) throw new HttpError(409, 'Someone else changed this quote. Refresh and try again.', 'CONFLICT');
    ctx.exec.waitUntil(dispatchJobsForQuote(ctx.env, q.business_id, q.id).catch(() => undefined));
    return json({ ok: true });
  });

  // ---- dashboard ----
  r.get('/dashboard', async (ctx) => {
    const st = await requireStaff(ctx);
    const businessId = ctx.session!.business_id;
    const db = ctx.env.DB;
    const seeAll = can(st, 'quotes.view_all');
    const recent = await db.prepare(
      `SELECT id, order_no, created_at, staff_name, customer_name, metal, purity, net_mg, offer_paise, status FROM quotes
       WHERE business_id = ? AND (?2 = 1 OR staff_id = ?3) ORDER BY created_at DESC LIMIT 8`,
    ).bind(businessId, seeAll ? 1 : 0, st.id).all();
    const out: Record<string, unknown> = { recent: recent.results };
    if (can(st, 'dashboard.metrics')) {
      const todayStart = istDayStart(new Date(ctx.now + 5.5 * 3600_000).toISOString().slice(0, 10))!;
      const m = await db.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
                COALESCE(SUM(CASE WHEN status != 'cancelled' THEN offer_paise ELSE 0 END), 0) AS offers_paise
         FROM quotes WHERE business_id = ?`,
      ).bind(todayStart, businessId).first<{ total: number; today: number | null; offers_paise: number }>();
      out.metrics = { total_quotes: m?.total ?? 0, today_quotes: m?.today ?? 0, total_offers_paise: m?.offers_paise ?? 0 };
    }
    return json(out);
  });

}
