import { describe, expect, it } from 'vitest';
import { Client, OWNER, env, reauth, send, setupOwner } from './helpers';

describe('first-owner setup', () => {
  it('needs the setup code, works once, and returns recovery codes once', async () => {
    const c = new Client();
    expect((await c.get('/auth/me')).data).toMatchObject({ authenticated: false, setup_available: true });
    const bad = await c.post('/setup', { setup_token: 'wrong', business_name: 'X', owner_name: 'Y', email: 'a@b.co', password: 'long-password-1', pin: '482915' });
    expect(bad.status).toBe(403);

    const { owner, codes } = await setupOwner();
    expect(codes).toHaveLength(10);
    const me = (await owner.get('/auth/me')).data;
    expect(me).toMatchObject({ authenticated: true, owner_email: OWNER.email, staff: { role: 'owner' } });

    // second setup is refused
    const again = await new Client().post('/setup', { setup_token: 'test-setup-token-123456', business_name: 'Other', owner_name: 'Z', email: 'z@z.co', password: 'long-password-1', pin: '582916' });
    expect(again.status).toBe(409);
    expect((await new Client().get('/auth/me')).data.setup_available).toBe(false);

    // only hashes are stored: no recovery code, password or PIN in plaintext
    const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM recovery_codes').all()).results)
      + JSON.stringify((await env.DB.prepare('SELECT * FROM owner_accounts').all()).results)
      + JSON.stringify((await env.DB.prepare('SELECT * FROM staff').all()).results);
    expect(dump).not.toContain(codes[0]);
    expect(dump).not.toContain(codes[0].replace(/-/g, ''));
    expect(dump).not.toContain(OWNER.password);
    expect(dump).not.toContain(OWNER.pin);
  });

  it('rejects weak PINs and short passwords', async () => {
    const c = new Client();
    const r1 = await c.post('/setup', { setup_token: 'test-setup-token-123456', business_name: 'X', owner_name: 'Y', email: 'a@b.co', password: 'short', pin: '482915' });
    expect(r1.status).toBe(400);
    const r2 = await c.post('/setup', { setup_token: 'test-setup-token-123456', business_name: 'X', owner_name: 'Y', email: 'a@b.co', password: 'long-password-1', pin: '111111' });
    expect(r2.status).toBe(400);
  });
});

describe('business login and logout', () => {
  it('signs in with email/password, requires a PIN for the profile, and logs out', async () => {
    const { ownerStaffId } = await setupOwner();
    const c = new Client();
    expect((await c.post('/auth/login', { email: OWNER.email, password: 'wrong-password' })).status).toBe(401);
    const ok = await c.post('/auth/login', { email: 'OWNER@example.com', password: OWNER.password });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/);
    const me = (await c.get('/auth/me')).data;
    expect(me.authenticated).toBe(true);
    expect(me.staff).toBeNull(); // profile still locked
    expect((await c.get('/dashboard')).status).toBe(401);
    expect((await c.post('/staff/unlock', { staff_id: ownerStaffId, pin: OWNER.pin })).status).toBe(200);
    expect((await c.get('/dashboard')).status).toBe(200);

    expect((await c.post('/auth/logout')).status).toBe(200);
    expect((await c.get('/auth/me')).data.authenticated).toBe(false);
    expect((await c.get('/dashboard')).status).toBe(401);
  });

  it('rate-limits repeated wrong passwords', async () => {
    await setupOwner();
    const c = new Client();
    for (let i = 0; i < 8; i++) expect((await c.post('/auth/login', { email: OWNER.email, password: `nope-nope-${i}` })).status).toBe(401);
    expect((await c.post('/auth/login', { email: OWNER.email, password: OWNER.password })).status).toBe(429);
  });

  it('requires the CSRF token and refuses cross-site writes', async () => {
    const { owner } = await setupOwner();
    const noToken = await owner.req('POST', '/rates', { metal: 'gold', rate: '7000' }, { noCsrf: true });
    expect(noToken.status).toBe(403);
    expect(noToken.data.code).toBe('CSRF');
    const cross = await owner.req('POST', '/rates', { metal: 'gold', rate: '7000' }, { headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect((await owner.post('/rates', { metal: 'gold', rate: '7000' })).status).toBe(201);
  });

  it('revokes every session when the password changes', async () => {
    const { owner } = await setupOwner();
    const other = new Client();
    await other.post('/auth/login', { email: OWNER.email, password: OWNER.password });
    expect((await other.get('/auth/me')).data.authenticated).toBe(true);
    await env.DB.prepare('UPDATE sessions SET reauth_at = 0').run(); // setup's confirmation has expired
    expect((await owner.post('/auth/password', { new_password: 'a-brand-new-password' })).status).toBe(403); // needs re-auth
    await reauth(owner);
    expect((await owner.post('/auth/password', { new_password: 'a-brand-new-password' })).status).toBe(200);
    expect((await other.get('/auth/me')).data.authenticated).toBe(false);
    expect((await owner.get('/auth/me')).data.authenticated).toBe(true); // this device got a fresh session
    expect((await new Client().post('/auth/login', { email: OWNER.email, password: OWNER.password })).status).toBe(401);
    expect((await new Client().post('/auth/login', { email: OWNER.email, password: 'a-brand-new-password' })).status).toBe(200);
  });
});

describe('owner recovery codes', () => {
  it('a code works once, replaces all codes, and revokes sessions', async () => {
    const { codes } = await setupOwner();
    const old = new Client();
    await old.post('/auth/login', { email: OWNER.email, password: OWNER.password });

    const c = new Client();
    const wrong = await c.post('/auth/recover', { email: OWNER.email, code: 'AAAA-BBBB-CCCC-DDDD', new_password: 'recovered-password-1' });
    expect(wrong.status).toBe(401);
    const ok = await c.post('/auth/recover', { email: OWNER.email, code: codes[0].toLowerCase(), new_password: 'recovered-password-1', new_pin: '640218' });
    expect(ok.status).toBe(200);
    expect(ok.data.recovery_codes).toHaveLength(10);
    expect(ok.data.recovery_codes).not.toContain(codes[1]);
    expect((await c.get('/auth/me')).data.staff.role).toBe('owner');
    expect((await old.get('/auth/me')).data.authenticated).toBe(false);

    // the used code and every other old code are now invalid
    const reuse = await new Client().post('/auth/recover', { email: OWNER.email, code: codes[0], new_password: 'another-password-1' });
    expect(reuse.status).toBe(401);
    const otherOld = await new Client().post('/auth/recover', { email: OWNER.email, code: codes[1], new_password: 'another-password-1' });
    expect(otherOld.status).toBe(401);
    // a new code works
    const fresh = await new Client().post('/auth/recover', { email: OWNER.email, code: ok.data.recovery_codes[3], new_password: 'another-password-1' });
    expect(fresh.status).toBe(200);
  });

  it('rate-limits recovery attempts', async () => {
    await setupOwner();
    const c = new Client();
    for (let i = 0; i < 5; i++) await c.post('/auth/recover', { email: OWNER.email, code: 'AAAA-BBBB-CCCC-DDD' + i, new_password: 'recovered-password-1' });
    const r = await c.post('/auth/recover', { email: OWNER.email, code: 'AAAA-BBBB-CCCC-DDDX', new_password: 'recovered-password-1' });
    expect(r.status).toBe(429);
  });

  it('regenerating codes needs recent password confirmation', async () => {
    const { owner, codes } = await setupOwner();
    // setup counts as a fresh confirmation; simulate it expiring
    await env.DB.prepare('UPDATE sessions SET reauth_at = 0').run();
    expect((await owner.post('/auth/recovery-codes')).data.code).toBe('REAUTH_REQUIRED');
    await reauth(owner);
    const r = await owner.post('/auth/recovery-codes');
    expect(r.data.recovery_codes).toHaveLength(10);
    expect((await new Client().post('/auth/recover', { email: OWNER.email, code: codes[0], new_password: 'recovered-password-1' })).status).toBe(401);
  });
});

describe('API routing', () => {
  it('never returns HTML for /api, and has a safe health check', async () => {
    const r = await send('/api/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
    const m = await send('/api/auth/me', { method: 'DELETE' });
    expect(m.status).toBe(405);
    expect(m.headers.get('content-type')).toContain('application/json');
    const h = await send('/api/health');
    const body = await h.json<Record<string, unknown>>();
    expect(body).toMatchObject({ status: 'ok', database: 'ok' });
    expect(JSON.stringify(body)).not.toMatch(/pepper|secret|token|key/i);
    expect(h.headers.get('x-frame-options')).toBe('DENY');
  });

  it('redirects the bare domain to the canonical host', async () => {
    const r = await send('/transactions?x=1', {}, { REDIRECT_HOSTS: 'localhost', APP_ORIGIN: 'https://www.swarnalive.com' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://www.swarnalive.com/transactions?x=1');
  });
});
