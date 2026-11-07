import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as rawEnv } from 'cloudflare:workers';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/env';

export const env = rawEnv as unknown as Env;
export const ORIGIN = 'http://localhost:8787';
export const OWNER = { email: 'owner@example.com', password: 'gold-and-silver-123', pin: '482915', name: 'Lakshmi' };

export async function send(path: string, init: RequestInit = {}, envOverride: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(ORIGIN + path, init) as Request<unknown, IncomingRequestCfProperties>, { ...env, ...envOverride } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A browser-like client: keeps the session cookie and CSRF token. */
export class Client {
  cookie = '';
  csrf = '';
  constructor(public envOverride: Partial<Env> = {}) {}

  async req(method: string, path: string, body?: unknown, opts: { raw?: BodyInit; type?: string; headers?: Record<string, string>; noCsrf?: boolean } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET' && this.csrf && !opts.noCsrf) headers['x-csrf-token'] = this.csrf;
    let payload: BodyInit | undefined;
    if (opts.raw !== undefined) { payload = opts.raw; headers['content-type'] = opts.type ?? 'application/octet-stream'; }
    else if (method !== 'GET') { payload = JSON.stringify(body ?? {}); headers['content-type'] = 'application/json'; }
    const res = await send(`/api${path}`, { method, headers, body: payload, redirect: 'manual' }, this.envOverride);
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json<any>() : await res.text();
    if (data && typeof data === 'object' && typeof data.csrf_token === 'string') this.csrf = data.csrf_token;
    return { status: res.status, data, headers: res.headers };
  }
  get(p: string) { return this.req('GET', p); }
  post(p: string, b?: unknown) { return this.req('POST', p, b); }
  put(p: string, b?: unknown) { return this.req('PUT', p, b); }

  async refreshMe() { return this.get('/auth/me'); }
}

export async function setupOwner(): Promise<{ owner: Client; codes: string[]; ownerStaffId: string }> {
  const owner = new Client();
  const r = await owner.post('/setup', { setup_token: 'test-setup-token-123456', business_name: 'Sri Lakshmi Jewellers', owner_name: OWNER.name, email: OWNER.email, password: OWNER.password, pin: OWNER.pin });
  if (r.status !== 201) throw new Error(`setup failed ${r.status} ${JSON.stringify(r.data)}`);
  const me = await owner.refreshMe();
  return { owner, codes: r.data.recovery_codes, ownerStaffId: me.data.staff.id };
}

/** Signs in a new device for the same business and unlocks a profile. */
export async function deviceFor(email: string, password: string, staffId?: string, pin?: string) {
  const c = new Client();
  const r = await c.post('/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  if (staffId) {
    const u = await c.post('/staff/unlock', { staff_id: staffId, pin });
    if (u.status !== 200) throw new Error(`unlock failed ${u.status} ${JSON.stringify(u.data)}`);
  }
  return c;
}

export async function reauth(c: Client, password = OWNER.password) {
  const r = await c.post('/auth/reauth', { password });
  if (r.status !== 200) throw new Error('reauth failed');
}

export async function addStaff(owner: Client, name: string, role: 'admin' | 'employee', permissions?: string[], pin = '730146') {
  await reauth(owner);
  const r = await owner.post('/staff', { name, role, permissions, pin });
  if (r.status !== 201) throw new Error(`add staff failed ${JSON.stringify(r.data)}`);
  return r.data.id as string;
}

/** Unlocks a newly-created staff profile on a new device and sets a permanent PIN. */
export async function staffDevice(staffId: string, tempPin = '730146', newPin = '918273') {
  const c = await deviceFor(OWNER.email, OWNER.password, staffId, tempPin);
  const r = await c.post('/staff/me/pin', { new_pin: newPin });
  if (r.status !== 200) throw new Error(`pin change failed ${JSON.stringify(r.data)}`);
  return c;
}

/** Minimal valid JPEG header (SOF0 with the given size) padded with bytes. */
export function jpeg(width = 1200, height = 900, pad = 2000): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const out = new Uint8Array(head.length + pad + 2);
  out.set(head);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

export async function uploadPhoto(c: Client, bytes = jpeg()) {
  const r = await c.req('POST', '/photos', undefined, { raw: bytes, type: 'image/jpeg' });
  if (r.status !== 201) throw new Error(`photo upload failed ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.id as string;
}

export async function setRate(c: Client, metal: 'gold' | 'silver', rate: string) {
  const r = await c.post('/rates', { metal, rate });
  if (r.status !== 201) throw new Error(`rate failed ${JSON.stringify(r.data)}`);
  return r.data.id as string;
}

let keyCounter = 0;
export const newKey = () => `test-key-${Date.now()}-${++keyCounter}-${crypto.randomUUID().slice(0, 8)}`;

export interface QuoteOpts {
  metal?: 'gold' | 'silver'; purity?: string; gross?: string; deduction?: string; pct?: string; name?: string; phone?: string;
  notes?: string; override_reason?: string; key?: string; photoId?: string; rateVersionId?: string; expectedOffer?: number;
}

/** Creates a quote the way the browser does: fetch the rate, compute the expected offer, upload the photo, submit. */
export async function createQuote(c: Client, o: QuoteOpts = {}) {
  const { computeQuote, parseGramsToMg, parsePercentToBp } = await import('../src/shared/calc');
  const metal = o.metal ?? 'gold';
  const rates = (await c.get('/rates')).data;
  const rate = rates[metal];
  const body = {
    idempotency_key: o.key ?? newKey(),
    customer_name: o.name ?? 'Ravi Kumar', customer_phone: o.phone ?? '98480 12345', metal, item_type: 'Chain',
    description: 'Gold chain with hook', purity: o.purity ?? (metal === 'gold' ? '22K' : '999'),
    gross_weight: o.gross ?? '10.500', deduction_weight: o.deduction ?? '0.500', buyback_pct: o.pct ?? '60', notes: o.notes ?? '',
    override_reason: o.override_reason, photo_id: o.photoId ?? await uploadPhoto(c),
    rate_version_id: o.rateVersionId ?? rate?.id,
    expected_offer_paise: o.expectedOffer ?? (rate ? computeQuote({
      metal, purity: o.purity ?? (metal === 'gold' ? '22K' : '999'), grossMg: parseGramsToMg(o.gross ?? '10.500')!,
      deductionMg: parseGramsToMg(o.deduction ?? '0.500')!, baseRatePaise: rate.rate_paise, pctBp: parsePercentToBp(o.pct ?? '60')!,
    }).offerPaise : 0),
  };
  return c.post('/quotes', body);
}
