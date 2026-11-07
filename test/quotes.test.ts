import { describe, expect, it } from 'vitest';
import {
  Client, OWNER, addStaff, createQuote, env, jpeg, newKey, reauth, send, setRate, setupOwner, staffDevice, uploadPhoto,
} from './helpers';
import { cleanupAbandonedPhotos } from '../src/worker/routes/quotes';
import type { Env } from '../src/worker/env';

describe('business-entered rates', () => {
  it('blocks quotes when the rate is missing, and records rate history', async () => {
    const { owner } = await setupOwner();
    const r = await createQuote(owner);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('RATE_MISSING');

    expect((await owner.post('/rates', { metal: 'gold', rate: '0' })).status).toBe(400);
    expect((await owner.post('/rates', { metal: 'gold', rate: 'abc' })).status).toBe(400);
    await setRate(owner, 'gold', '7200');
    await setRate(owner, 'gold', '7250.50');
    const rates = (await owner.get('/rates')).data;
    expect(rates.gold).toMatchObject({ rate_paise: 725050, created_by_name: OWNER.name });
    expect(rates.silver).toBeNull();
    const hist = (await owner.get('/rates/history')).data.items;
    expect(hist.map((x: { rate_paise: number }) => x.rate_paise)).toEqual([725050, 720000]);

    // silver still blocked while gold works
    expect((await createQuote(owner, { metal: 'silver' })).data.code).toBe('RATE_MISSING');
    expect((await createQuote(owner)).status).toBe(201);
  });

  it('stores the exact rate version with the quote; later rate changes do not alter it', async () => {
    const { owner } = await setupOwner();
    const v1 = await setRate(owner, 'gold', '7200');
    const q = (await createQuote(owner, { gross: '10', deduction: '0' })).data.quote;
    expect(q).toMatchObject({ rate_version_id: v1, base_rate_paise: 720000, applied_rate_paise: 660000, net_mg: 10000, assessed_paise: 6600000, offer_paise: 3960000, pct_bp: 6000 });
    await setRate(owner, 'gold', '9000');
    const again = (await owner.get(`/quotes/${q.id}`)).data.quote;
    expect(again.offer_paise).toBe(3960000);
    expect(again.rate_version_id).toBe(v1);
  });

  it('requires review when the rate changes while preparing a quote', async () => {
    const { owner } = await setupOwner();
    const v1 = await setRate(owner, 'gold', '7200');
    const photo = await uploadPhoto(owner);
    const key = newKey();
    // someone else changes the rate before this quote is submitted
    await setRate(owner, 'gold', '7400');
    const stale = await createQuote(owner, { key, photoId: photo, rateVersionId: v1, gross: '10', deduction: '0', expectedOffer: 3960000 });
    expect(stale.status).toBe(409);
    expect(stale.data.code).toBe('RATE_CHANGED');
    expect(stale.data.current.offer_paise).toBe(4069998); // 7400×22/24 = ₹6,783.33/g → × 10 g × 60% = ₹40,699.98
    // nothing was saved
    expect((await owner.get('/quotes')).data.total).toBe(0);
    // resubmitting after review with the new version and offer works (same key, same photo)
    const ok = await createQuote(owner, { key, photoId: photo, rateVersionId: stale.data.current.rate_version_id, gross: '10', deduction: '0', expectedOffer: stale.data.current.offer_paise });
    expect(ok.status).toBe(201);
    expect(ok.data.quote.offer_paise).toBe(4069998);
  });

  it('never trusts a client-calculated offer', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const r = await createQuote(owner, { gross: '10', deduction: '0', expectedOffer: 9999999 });
    expect(r.status).toBe(409);
    expect(r.data.code).toBe('OFFER_MISMATCH');
  });
});

describe('quote validation', () => {
  it('rejects invalid weights, deductions, percentages and purities', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    await setRate(owner, 'silver', '95');
    const cases: [Parameters<typeof createQuote>[1], string][] = [
      [{ gross: '0' }, 'GROSS_INVALID'],
      [{ gross: '-5' }, 'GROSS_INVALID'],
      [{ gross: '5', deduction: '5' }, 'DEDUCTION_INVALID'],
      [{ gross: '5', deduction: '6' }, 'DEDUCTION_INVALID'],
      [{ pct: '0' }, 'PERCENT_INVALID'],
      [{ pct: '101' }, 'PERCENT_INVALID'],
      [{ metal: 'gold', purity: '999' }, 'PURITY_INVALID'],
      [{ metal: 'silver', purity: '22K' }, 'PURITY_INVALID'],
      [{ phone: '12345' }, 'INVALID'],
    ];
    for (const [opts, code] of cases) {
      const r = await createQuote(owner, { ...opts, expectedOffer: 1 });
      expect(r.status, JSON.stringify(opts)).toBe(400);
      expect(r.data.code, JSON.stringify(opts)).toBe(code);
    }
  });

  it('calculates silver correctly and stores +91 phone numbers', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'silver', '95');
    const q = (await createQuote(owner, { metal: 'silver', gross: '250', deduction: '0', phone: '+91 98480-12345' })).data.quote;
    expect(q).toMatchObject({ purity: '999', applied_rate_paise: 9500, assessed_paise: 2375000, offer_paise: 1425000, customer_phone: '+919848012345' });
  });

  it('enforces staff percentage limits; owner may override with a reason, which is audited', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const empId = await addStaff(owner, 'Arjun', 'employee');
    const emp = await staffDevice(empId);
    expect((await createQuote(emp, { pct: '55' })).status).toBe(201); // inside 50–60
    const over = await createQuote(emp, { pct: '70' });
    expect(over.status).toBe(403);
    expect(over.data.code).toBe('PERCENT_LIMIT');

    const noReason = await createQuote(owner, { pct: '75' });
    expect(noReason.data.code).toBe('OVERRIDE_REASON_REQUIRED');
    const ok = await createQuote(owner, { pct: '75', override_reason: 'Long-standing customer' });
    expect(ok.status).toBe(201);
    expect(ok.data.quote.pct_override).toBe(1);
    const detail = (await owner.get(`/quotes/${ok.data.quote.id}`)).data;
    expect(detail.audit.map((a: { action: string }) => a.action)).toContain('quote.percentage_override');

    // the owner can widen the limits
    expect((await owner.put('/settings/buyback', { default_pct: '65', staff_min_pct: '50', staff_max_pct: '70' })).status).toBe(200);
    expect((await createQuote(emp, { pct: '70' })).status).toBe(201);
  });
});

describe('required photograph', () => {
  it('cannot save without a valid uploaded photo', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const r = await createQuote(owner, { photoId: 'not-a-photo' });
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PHOTO_REQUIRED');

    const html = await owner.req('POST', '/photos', undefined, { raw: '<html></html>', type: 'image/jpeg' });
    expect(html.status).toBe(400);
    const tiny = await owner.req('POST', '/photos', undefined, { raw: jpeg(200, 150), type: 'image/jpeg' });
    expect(tiny.data.code).toBe('PHOTO_DIMENSIONS');
    const wrongType = await owner.req('POST', '/photos', undefined, { raw: jpeg(), type: 'image/gif' });
    expect(wrongType.status).toBe(400);
    const huge = await owner.req('POST', '/photos', undefined, { raw: jpeg(1200, 900, 5.5 * 1024 * 1024), type: 'image/jpeg' });
    expect(huge.status).toBe(413);
  });

  it('a photo can only be attached once, and only by the person who took it', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const empId = await addStaff(owner, 'Arjun', 'employee');
    const emp = await staffDevice(empId);
    const photo = await uploadPhoto(owner);
    expect((await createQuote(emp, { photoId: photo })).data.code).toBe('PHOTO_REQUIRED');
    expect((await createQuote(owner, { photoId: photo })).status).toBe(201);
    expect((await createQuote(owner, { photoId: photo })).data.code).toBe('PHOTO_REQUIRED');
  });

  it('photos are private: no access without sign-in or from another business', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const q = (await createQuote(owner)).data.quote;
    expect((await send(`/api/photos/${q.photo_id}`)).status).toBe(401);
    expect((await owner.get(`/photos/${q.photo_id}`)).status).toBe(200);
  });
});

describe('duplicates and order numbers', () => {
  it('the same submission twice creates one quote', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const key = newKey();
    const photo = await uploadPhoto(owner);
    const first = await createQuote(owner, { key, photoId: photo });
    const second = await createQuote(owner, { key, photoId: photo });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.data.duplicate).toBe(true);
    expect(second.data.quote.id).toBe(first.data.quote.id);
    expect((await owner.get('/quotes')).data.total).toBe(1);
  });

  it('allocates unique YY-NNNN numbers under concurrent requests', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const photos = await Promise.all(Array.from({ length: 12 }, () => uploadPhoto(owner)));
    const results = await Promise.all(photos.map((p) => createQuote(owner, { photoId: p })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.data.quote.order_no as string).sort();
    const yy = String(new Date(Date.now() + 5.5 * 3600_000).getUTCFullYear() % 100).padStart(2, '0');
    expect(new Set(numbers).size).toBe(12);
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => `${yy}-${String(i + 1).padStart(4, '0')}`));
  });

  it('keeps a separate sequence per business and per IST year, growing past 4 digits', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const biz = (await owner.get('/auth/me')).data.business.id;
    const year = new Date(Date.now() + 5.5 * 3600_000).getUTCFullYear();
    await env.DB.prepare('INSERT INTO order_counters (business_id, year, last_seq) VALUES (?, ?, 9999)').bind(biz, year).run();
    const q = (await createQuote(owner)).data.quote;
    expect(q.order_no).toBe(`${String(year % 100).padStart(2, '0')}-10000`);
  });
});

describe('partial failures between D1 and R2', () => {
  it('an R2 failure during upload leaves no photo record and reports an error', async () => {
    const { owner } = await setupOwner();
    const failingBucket = { ...env.PHOTOS, put: async () => { throw new Error('R2 down'); } } as unknown as R2Bucket;
    const broken = Object.assign(new Client({ PHOTOS: failingBucket } as Partial<Env>), { cookie: owner.cookie, csrf: owner.csrf });
    const r = await broken.req('POST', '/photos', undefined, { raw: jpeg(), type: 'image/jpeg' });
    expect(r.status).toBe(503);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM photos').first<{ n: number }>())!.n).toBe(0);
  });

  it('a D1 failure while saving does not report success and keeps the photo for a retry', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const photo = await uploadPhoto(owner);
    const realDb = env.DB;
    const failingDb = new Proxy(realDb, {
      get(target, prop) {
        if (prop === 'batch') return async (stmts: D1PreparedStatement[]) => { if (stmts.length > 4) throw new Error('D1 unavailable'); return target.batch(stmts); };
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const broken = Object.assign(new Client({ DB: failingDb } as Partial<Env>), { cookie: owner.cookie, csrf: owner.csrf });
    const key = newKey();
    const r = await createQuote(broken, { photoId: photo, key });
    expect(r.status).toBe(503);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM quotes').first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare('SELECT state FROM photos WHERE id = ?').bind(photo).first<{ state: string }>())!.state).toBe('pending');
    // retry with the same key and photo succeeds
    expect((await createQuote(owner, { photoId: photo, key })).status).toBe(201);
  });

  it('cleanup removes abandoned uploads but never attached photos', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const abandoned = await uploadPhoto(owner);
    const q = (await createQuote(owner)).data.quote;
    await env.DB.prepare('UPDATE photos SET created_at = 0').run(); // make everything look old
    const removed = await cleanupAbandonedPhotos(env, Date.now());
    expect(removed).toBe(1);
    expect(await env.DB.prepare('SELECT id FROM photos WHERE id = ?').bind(abandoned).first()).toBeNull();
    expect((await owner.get(`/photos/${q.photo_id}`)).status).toBe(200);
    const objects = await env.PHOTOS.list();
    expect(objects.objects).toHaveLength(1);
  });
});

describe('transactions', () => {
  it('search, filters and pagination', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    for (let i = 0; i < 23; i++) await createQuote(owner, { name: i === 5 ? 'Padma Kumari' : `Customer ${i}`, phone: i === 7 ? '9000011111' : '9848012345' });
    const p1 = (await owner.get('/quotes?page=1&page_size=10')).data;
    expect(p1).toMatchObject({ total: 23, pages: 3, page: 1 });
    expect(p1.items).toHaveLength(10);
    const p3 = (await owner.get('/quotes?page=3&page_size=10')).data;
    expect(p3.items).toHaveLength(3);
    expect((await owner.get('/quotes?q=padma')).data.total).toBe(1);
    expect((await owner.get('/quotes?q=90000')).data.total).toBe(1);
    const no = p1.items[0].order_no;
    expect((await owner.get(`/quotes?q=${no}`)).data.items[0].order_no).toBe(no);
    expect((await owner.get('/quotes?status=cancelled')).data.total).toBe(0);
    expect((await owner.get('/quotes?from=2020-01-01&to=2020-01-31')).data.total).toBe(0);
    expect((await owner.get('/quotes?from=bad')).status).toBe(400);
  });

  it('status changes and corrections keep the original values and are audited', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const q = (await createQuote(owner, { name: 'Ravi' })).data.quote;
    expect((await owner.post(`/quotes/${q.id}/status`, { status: 'accepted' })).status).toBe(400); // reason required
    expect((await owner.post(`/quotes/${q.id}/status`, { status: 'accepted', reason: 'Customer agreed' })).status).toBe(200);
    expect((await owner.post(`/quotes/${q.id}/correct`, { customer_name: 'Ravi Kumar', reason: 'Spelling' })).status).toBe(200);
    // monetary fields cannot be "corrected"
    const sneaky = await owner.post(`/quotes/${q.id}/correct`, { offer_paise: 1, reason: 'x' });
    expect(sneaky.status).toBe(400);
    const d = (await owner.get(`/quotes/${q.id}`)).data;
    expect(d.quote).toMatchObject({ status: 'accepted', customer_name: 'Ravi Kumar', offer_paise: q.offer_paise });
    expect(d.original).toMatchObject({ customer_name: 'Ravi', status: 'estimated', offer_paise: q.offer_paise });
    const status = d.audit.find((a: { action: string }) => a.action === 'quote.status_changed');
    expect(status).toMatchObject({ staff_name: OWNER.name, reason: 'Customer agreed' });
    expect(JSON.parse(status.before_json)).toEqual({ status: 'estimated' });
    expect(JSON.parse(status.after_json)).toEqual({ status: 'accepted' });
    const corr = d.audit.find((a: { action: string }) => a.action === 'quote.corrected');
    expect(JSON.parse(corr.before_json)).toEqual({ customer_name: 'Ravi' });
  });

  it('CSV export neutralises formulas and keeps phone numbers as text', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    await createQuote(owner, { name: '=HYPERLINK("http://evil.example","click")', notes: '@SUM(1,2)' });
    const r = await owner.get('/quotes/export.csv');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const text = r.data as string;
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(text).toContain(`'@SUM(1,2)`);
    expect(text).toContain(`'+919848012345`);
    expect(text).not.toMatch(/,=HYPERLINK/);
  });
});

describe('business isolation', () => {
  it('a second business cannot see the first business’s data', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const q = (await createQuote(owner)).data.quote;

    // platform admin provisions another business
    const adminHeaders = { authorization: 'Bearer test-admin-token-0123456789abcdef0123456789', 'content-type': 'application/json' };
    expect((await send('/api/admin/businesses', { method: 'POST', headers: { ...adminHeaders, authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401);
    const prov = await send('/api/admin/businesses', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Other Jewellers', owner_email: 'other@example.com' }) });
    expect(prov.status).toBe(201);
    const { invite_url } = await prov.json<{ invite_url: string }>();
    const token = invite_url.split('#')[1];
    const other = new Client();
    const acc = await other.post('/setup/invite', { invite_token: token, owner_name: 'Kiran', password: 'other-password-123', pin: '507193' });
    expect(acc.status).toBe(201);
    // invitation cannot be reused
    expect((await new Client().post('/setup/invite', { invite_token: token, owner_name: 'X', password: 'other-password-123', pin: '507193' })).status).toBe(403);

    expect((await other.get('/quotes')).data.total).toBe(0);
    expect((await other.get(`/quotes/${q.id}`)).status).toBe(404);
    expect((await other.get(`/photos/${q.photo_id}`)).status).toBe(404);
    expect((await other.get('/rates')).data.gold).toBeNull();
    const ownerStaff = (await owner.get('/auth/me')).data.staff.id;
    expect((await other.post('/staff/unlock', { staff_id: ownerStaff, pin: OWNER.pin })).status).toBe(404);
    await reauth(other, 'other-password-123');
    expect((await other.post(`/staff/${ownerStaff}/disable`)).status).toBe(404);
    expect((await other.post(`/quotes/${q.id}/status`, { status: 'cancelled', reason: 'x' })).status).toBe(404);
    // its own order sequence starts at 0001
    await setRate(other, 'gold', '7000');
    const oq = (await createQuote(other)).data.quote;
    expect(oq.order_no.endsWith('-0001')).toBe(true);
    const csv = (await other.get('/quotes/export.csv')).data as string;
    expect(csv).not.toContain(q.order_no === oq.order_no ? '___' : q.id);
  });
});
