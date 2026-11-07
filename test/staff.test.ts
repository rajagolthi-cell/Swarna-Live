import { describe, expect, it } from 'vitest';
import { Client, OWNER, addStaff, createQuote, deviceFor, env, reauth, setRate, setupOwner, staffDevice } from './helpers';

describe('staff PINs', () => {
  it('locks a profile after 5 wrong PINs', async () => {
    const { owner } = await setupOwner();
    const empId = await addStaff(owner, 'Arjun', 'employee');
    const c = new Client();
    await c.post('/auth/login', { email: OWNER.email, password: OWNER.password });
    for (let i = 1; i <= 4; i++) {
      const r = await c.post('/staff/unlock', { staff_id: empId, pin: '000001' });
      expect(r.status).toBe(401);
    }
    const locked = await c.post('/staff/unlock', { staff_id: empId, pin: '000001' });
    expect(locked.status).toBe(423);
    // even the right PIN is refused while locked
    expect((await c.post('/staff/unlock', { staff_id: empId, pin: '730146' })).status).toBe(423);
    // lock expires
    await env.DB.prepare('UPDATE staff SET pin_locked_until = 1 WHERE id = ?').bind(empId).run();
    expect((await c.post('/staff/unlock', { staff_id: empId, pin: '730146' })).status).toBe(200);
  });

  it('forces a new PIN after the owner sets or resets one', async () => {
    const { owner } = await setupOwner();
    const empId = await addStaff(owner, 'Arjun', 'employee');
    const c = await deviceFor(OWNER.email, OWNER.password, empId, '730146');
    expect((await c.get('/dashboard')).data.code).toBe('PIN_CHANGE_REQUIRED');
    expect((await c.post('/staff/me/pin', { new_pin: '918273' })).status).toBe(200);
    expect((await c.get('/dashboard')).status).toBe(200);
  });

  it('automatically locks an inactive profile', async () => {
    const { owner } = await setupOwner();
    await env.DB.prepare('UPDATE sessions SET staff_active_at = ?').bind(Date.now() - 11 * 60_000).run();
    const r = await owner.get('/dashboard');
    expect(r.status).toBe(401);
    expect(r.data.code).toBe('PROFILE_LOCKED');
    const me = (await owner.get('/auth/me')).data;
    expect(me.authenticated).toBe(true); // business session stays
    expect(me.staff).toBeNull();
  });

  it('switch profile keeps the business session; logout ends it', async () => {
    const { owner, ownerStaffId } = await setupOwner();
    expect((await owner.post('/staff/lock')).status).toBe(200);
    expect((await owner.get('/auth/me')).data).toMatchObject({ authenticated: true, staff: null });
    expect((await owner.post('/staff/unlock', { staff_id: ownerStaffId, pin: OWNER.pin })).status).toBe(200);
    expect((await owner.post('/auth/logout')).status).toBe(200);
    expect((await owner.get('/auth/me')).data.authenticated).toBe(false);
  });
});

describe('staff management by the owner', () => {
  it('requires recent password confirmation', async () => {
    const { owner } = await setupOwner();
    await env.DB.prepare('UPDATE sessions SET reauth_at = 0').run();
    const r = await owner.post('/staff', { name: 'X', role: 'employee', pin: '730146' });
    expect(r.data.code).toBe('REAUTH_REQUIRED');
  });

  it('disabling or revoking a profile signs it out everywhere', async () => {
    const { owner } = await setupOwner();
    const empId = await addStaff(owner, 'Arjun', 'employee');
    const emp = await staffDevice(empId);
    expect((await emp.get('/dashboard')).status).toBe(200);

    await reauth(owner);
    expect((await owner.post(`/staff/${empId}/revoke`)).status).toBe(200);
    expect((await emp.get('/dashboard')).status).toBe(401);
    expect((await emp.post('/staff/unlock', { staff_id: empId, pin: '918273' })).status).toBe(200);

    expect((await owner.post(`/staff/${empId}/disable`, { reason: 'Left the shop' })).status).toBe(200);
    expect((await emp.get('/dashboard')).status).toBe(401);
    expect((await emp.post('/staff/unlock', { staff_id: empId, pin: '918273' })).status).toBe(404);
    const profiles = (await emp.get('/staff/profiles')).data as { id: string }[];
    expect(profiles.some((p) => p.id === empId)).toBe(false);
  });

  it('employees and admins cannot manage staff', async () => {
    const { owner } = await setupOwner();
    const adminId = await addStaff(owner, 'Meena', 'admin', ['quotes.create', 'quotes.view_all', 'rates.update', 'audit.view']);
    const admin = await staffDevice(adminId);
    expect((await admin.get('/staff')).status).toBe(403);
    expect((await admin.post('/staff', { name: 'X', role: 'admin', pin: '730146' })).status).toBe(403);
    expect((await admin.post(`/staff/${adminId}/disable`)).status).toBe(403);
  });

  it('cannot give employees owner-level permissions', async () => {
    const { owner } = await setupOwner();
    await reauth(owner);
    const r = await owner.post('/staff', { name: 'X', role: 'employee', permissions: ['settings.business'], pin: '730146' });
    expect(r.status).toBe(400);
  });
});

describe('role permissions', () => {
  it('employees cannot change rates, settings or see business totals; admins only what was granted', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const empId = await addStaff(owner, 'Arjun', 'employee');
    const emp = await staffDevice(empId);
    expect((await emp.post('/rates', { metal: 'gold', rate: '1' })).status).toBe(403);
    expect((await emp.put('/settings/business', { name: 'Hacked' })).status).toBe(403);
    expect((await emp.put('/settings/buyback', { default_pct: '90', staff_min_pct: '1', staff_max_pct: '100' })).status).toBe(403);
    expect((await emp.get('/audit')).status).toBe(403);
    expect((await emp.get('/google/status')).status).toBe(403);
    expect((await emp.get('/dashboard')).data.metrics).toBeUndefined();
    expect((await emp.get('/quotes/export.csv')).status).toBe(403);
    expect((await owner.get('/dashboard')).data.metrics).toBeDefined();

    const adminId = await addStaff(owner, 'Meena', 'admin', ['quotes.create', 'rates.update']);
    const admin = await staffDevice(adminId);
    expect((await admin.post('/rates', { metal: 'gold', rate: '7300' })).status).toBe(201);
    expect((await admin.get('/audit')).status).toBe(403);
    expect((await admin.put('/settings/buyback', { default_pct: '60', staff_min_pct: '50', staff_max_pct: '60' })).status).toBe(403);
  });

  it('employees only see their own transactions unless allowed', async () => {
    const { owner } = await setupOwner();
    await setRate(owner, 'gold', '7200');
    const aId = await addStaff(owner, 'Arjun', 'employee');
    const bId = await addStaff(owner, 'Bala', 'employee', ['quotes.create', 'quotes.view_all']);
    const a = await staffDevice(aId);
    const b = await staffDevice(bId);
    const ownerQuote = (await createQuote(owner, { name: 'Owner Customer' })).data.quote;
    const aQuote = (await createQuote(a, { name: 'Arjun Customer' })).data.quote;

    const aList = (await a.get('/quotes')).data.items as { id: string }[];
    expect(aList.map((x) => x.id)).toEqual([aQuote.id]);
    expect((await a.get(`/quotes/${ownerQuote.id}`)).status).toBe(404);
    expect((await a.get(`/photos/${ownerQuote.photo_id}`)).status).toBe(404);
    expect((await a.get(`/photos/${aQuote.photo_id}`)).status).toBe(200);

    expect(((await b.get('/quotes')).data.items as unknown[]).length).toBe(2);
    expect((await b.get(`/photos/${ownerQuote.photo_id}`)).status).toBe(200);
    // no status changes without permission
    expect((await b.post(`/quotes/${aQuote.id}/status`, { status: 'accepted', reason: 'x' })).status).toBe(403);
  });
});
