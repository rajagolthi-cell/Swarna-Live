import type { Ctx, StaffRow } from '../context';
import {
  assertNotLimited, auditStmt, checkCsrf, clearCookie, createSession, loadSession, recordAttempt,
  requireBusiness, requireOwner, requireRecentOwnerAuth, resolveStaff, REAUTH_WINDOW_MS,
} from '../context';
import { hashSecret, hmac, newRecoveryCode, normaliseRecoveryCode, safeEqual, sha256, verifySecret } from '../crypto';
import { HttpError, email, json, notFound, password, pin, str } from '../http';
import type { Router } from '../router';

const RECOVERY_CODE_COUNT = 10;

async function recoveryCodeStatements(ctx: Ctx, businessId: string, ownerId: string) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const stmt = ctx.env.DB.prepare('INSERT INTO recovery_codes (id, business_id, owner_id, code_hash, created_at) VALUES (?, ?, ?, ?, ?)');
  const stmts = await Promise.all(codes.map(async (c) =>
    stmt.bind(crypto.randomUUID(), businessId, ownerId, await hmac(ctx.env.AUTH_PEPPER, `recovery:${normaliseRecoveryCode(c)}`), ctx.now)));
  return { codes, stmts };
}

/** Statements that create the owner staff profile + business login + recovery codes. */
async function ownerStatements(ctx: Ctx, businessId: string, ownerName: string, ownerEmail: string, pw: string, ownerPin: string) {
  const staffId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const [pwHash, pinHash] = await Promise.all([hashSecret(pw, ctx.env.AUTH_PEPPER), hashSecret(ownerPin, ctx.env.AUTH_PEPPER)]);
  const { codes, stmts } = await recoveryCodeStatements(ctx, businessId, ownerId);
  const db = ctx.env.DB;
  return {
    staffId, ownerId, codes,
    stmts: [
      db.prepare(`INSERT INTO staff (id, business_id, name, role, permissions, pin_hash, created_at, updated_at)
                  VALUES (?, ?, ?, 'owner', '[]', ?, ?, ?)`).bind(staffId, businessId, ownerName, pinHash, ctx.now, ctx.now),
      db.prepare(`INSERT INTO owner_accounts (id, business_id, staff_id, email, password_hash, password_changed_at, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(ownerId, businessId, staffId, ownerEmail, pwHash, ctx.now, ctx.now),
      ...stmts,
    ],
  };
}

async function staffRow(ctx: Ctx, id: string, businessId: string) {
  return ctx.env.DB.prepare('SELECT * FROM staff WHERE id = ? AND business_id = ?').bind(id, businessId).first<StaffRow>();
}

export function authRoutes(r: Router) {
  // ---- first owner setup (one time, needs the SETUP_TOKEN secret) ----
  r.get('/setup/status', async (ctx) => {
    const any = await ctx.env.DB.prepare('SELECT 1 AS x FROM businesses LIMIT 1').first();
    return json({ setup_available: !any && !!ctx.env.SETUP_TOKEN });
  });

  r.post('/setup', async (ctx) => {
    if (!ctx.env.SETUP_TOKEN) throw notFound('Setup is not enabled.');
    await assertNotLimited(ctx, `setup:${ctx.ip}`, 10, 3600_000, 'Too many attempts. Try again later.');
    const b = ctx.body;
    if (typeof b.setup_token !== 'string' || !safeEqual(b.setup_token.trim(), ctx.env.SETUP_TOKEN)) {
      await recordAttempt(ctx, `setup:${ctx.ip}`);
      throw new HttpError(403, 'The setup code is not correct.', 'BAD_SETUP_TOKEN');
    }
    const businessName = str(b.business_name, 'Business name', { required: true, max: 120 })!;
    const ownerName = str(b.owner_name, 'Your name', { required: true, max: 80 })!;
    const ownerEmail = email(b.email);
    const pw = password(b.password);
    const ownerPin = pin(b.pin);
    const businessId = crypto.randomUUID();
    const owner = await ownerStatements(ctx, businessId, ownerName, ownerEmail, pw, ownerPin);
    const db = ctx.env.DB;
    try {
      await db.batch([
        // Only succeeds while there are no businesses at all; otherwise the inserts below fail their foreign keys.
        db.prepare(`INSERT INTO businesses (id, name, email, created_at, updated_at)
                    SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM businesses)`).bind(businessId, businessName, ownerEmail, ctx.now, ctx.now),
        ...owner.stmts,
        auditStmt(ctx, { businessId, action: 'business.setup', staff: { id: owner.staffId, name: ownerName }, after: { business_name: businessName, owner_email: ownerEmail } }),
      ]);
    } catch {
      throw new HttpError(409, 'Swarna Live has already been set up. Sign in instead.', 'ALREADY_SET_UP');
    }
    const staff = (await staffRow(ctx, owner.staffId, businessId))!;
    const { cookie, csrf } = await createSession(ctx, businessId, owner.ownerId, { staff, reauth: true });
    return json({ ok: true, recovery_codes: owner.codes, csrf_token: csrf }, 201, { 'Set-Cookie': cookie });
  });

  // ---- owner of an additional business accepts their invitation ----
  r.post('/setup/invite', async (ctx) => {
    await assertNotLimited(ctx, `invite:${ctx.ip}`, 10, 3600_000, 'Too many attempts. Try again later.');
    const b = ctx.body;
    const token = typeof b.invite_token === 'string' ? b.invite_token.trim() : '';
    const invite = token && await ctx.env.DB.prepare(
      'SELECT * FROM business_invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    ).bind(await sha256(token), ctx.now).first<{ token_hash: string; business_id: string; email: string }>();
    if (!invite) {
      await recordAttempt(ctx, `invite:${ctx.ip}`);
      throw new HttpError(403, 'This invitation link is invalid, expired or already used.', 'BAD_INVITE');
    }
    const ownerName = str(b.owner_name, 'Your name', { required: true, max: 80 })!;
    const pw = password(b.password);
    const ownerPin = pin(b.pin);
    const owner = await ownerStatements(ctx, invite.business_id, ownerName, invite.email, pw, ownerPin);
    const db = ctx.env.DB;
    try {
      await db.batch([
        db.prepare('UPDATE business_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(ctx.now, invite.token_hash),
        ...owner.stmts, // owner_accounts.business_id is UNIQUE, so a second acceptance fails and rolls back
        auditStmt(ctx, { businessId: invite.business_id, action: 'business.owner_setup', staff: { id: owner.staffId, name: ownerName } }),
      ]);
    } catch {
      throw new HttpError(409, 'This invitation has already been used.', 'BAD_INVITE');
    }
    const staff = (await staffRow(ctx, owner.staffId, invite.business_id))!;
    const { cookie, csrf } = await createSession(ctx, invite.business_id, owner.ownerId, { staff, reauth: true });
    return json({ ok: true, recovery_codes: owner.codes, csrf_token: csrf }, 201, { 'Set-Cookie': cookie });
  });

  // ---- business login ----
  r.post('/auth/login', async (ctx) => {
    const e = typeof ctx.body.email === 'string' ? ctx.body.email.trim().toLowerCase() : '';
    const keys = [`login:ip:${ctx.ip}`, `login:email:${e}`];
    await assertNotLimited(ctx, keys[0], 20, 15 * 60_000, 'Too many sign-in attempts. Please wait 15 minutes.');
    await assertNotLimited(ctx, keys[1], 8, 15 * 60_000, 'Too many sign-in attempts for this account. Please wait 15 minutes.');
    const owner = e ? await ctx.env.DB.prepare(
      `SELECT o.* FROM owner_accounts o JOIN businesses b ON b.id = o.business_id
       WHERE o.email = ? AND o.disabled = 0 AND b.disabled = 0`,
    ).bind(e).first<{ id: string; business_id: string; password_hash: string }>() : null;
    const ok = owner && typeof ctx.body.password === 'string' && await verifySecret(ctx.body.password, owner.password_hash, ctx.env.AUTH_PEPPER);
    if (!owner || !ok) {
      await recordAttempt(ctx, ...keys);
      throw new HttpError(401, 'Email or password is not correct.', 'BAD_CREDENTIALS');
    }
    const { cookie, csrf } = await createSession(ctx, owner.business_id, owner.id);
    return json({ ok: true, csrf_token: csrf }, 200, { 'Set-Cookie': cookie });
  });

  r.post('/auth/logout', async (ctx) => {
    const s = await loadSession(ctx);
    if (s) {
      ctx.session = s;
      checkCsrf(ctx);
      await ctx.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(s.id_hash).run();
    }
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(ctx.env) });
  });

  r.get('/auth/me', async (ctx) => {
    const s = await loadSession(ctx);
    if (!s) {
      const any = await ctx.env.DB.prepare('SELECT 1 AS x FROM businesses LIMIT 1').first();
      return json({ authenticated: false, setup_available: !any && !!ctx.env.SETUP_TOKEN });
    }
    ctx.session = s;
    const st = await resolveStaff(ctx);
    const logo = await ctx.env.DB.prepare('SELECT logo_key IS NOT NULL AS has_logo FROM businesses WHERE id = ?').bind(s.business_id).first<{ has_logo: number }>();
    return json({
      authenticated: true,
      csrf_token: s.csrf_token,
      business: { id: s.business_id, name: s.business_name, has_logo: !!logo?.has_logo },
      owner_email: s.owner_email,
      profile_lock_minutes: s.profile_lock_minutes,
      staff: st && { id: st.id, name: st.name, role: st.role, permissions: st.permissions, pin_must_change: st.pinMustChange },
      locked_reason: ctx.staffLockedReason ?? null,
      recent_owner_auth: !!st && st.role === 'owner' && !!s.reauth_at && ctx.now - s.reauth_at < REAUTH_WINDOW_MS,
    });
  });

  /** Owner re-enters the business password before a sensitive action. */
  r.post('/auth/reauth', async (ctx) => {
    await requireOwner(ctx);
    checkCsrf(ctx);
    const s = ctx.session!;
    const key = `reauth:${s.owner_id}`;
    await assertNotLimited(ctx, key, 5, 15 * 60_000, 'Too many wrong passwords. Please wait 15 minutes.');
    const owner = await ctx.env.DB.prepare('SELECT password_hash FROM owner_accounts WHERE id = ?').bind(s.owner_id).first<{ password_hash: string }>();
    if (!owner || typeof ctx.body.password !== 'string' || !(await verifySecret(ctx.body.password, owner.password_hash, ctx.env.AUTH_PEPPER))) {
      await recordAttempt(ctx, key);
      throw new HttpError(401, 'Password is not correct.', 'BAD_CREDENTIALS');
    }
    await ctx.env.DB.prepare('UPDATE sessions SET reauth_at = ? WHERE id_hash = ?').bind(ctx.now, s.id_hash).run();
    return json({ ok: true });
  });

  /** Change the business password. Every existing session is revoked; this device gets a fresh one. */
  r.post('/auth/password', async (ctx) => {
    const st = await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    const s = ctx.session!;
    const pw = password(ctx.body.new_password, 'New password');
    const hash = await hashSecret(pw, ctx.env.AUTH_PEPPER);
    const db = ctx.env.DB;
    await db.batch([
      db.prepare('UPDATE owner_accounts SET password_hash = ?, password_changed_at = ? WHERE id = ?').bind(hash, ctx.now, s.owner_id),
      db.prepare('DELETE FROM sessions WHERE owner_id = ?').bind(s.owner_id),
      auditStmt(ctx, { businessId: s.business_id, action: 'owner.password_changed' }),
    ]);
    const staff = (await staffRow(ctx, st.id, s.business_id))!;
    const { cookie, csrf } = await createSession(ctx, s.business_id, s.owner_id, { staff });
    return json({ ok: true, csrf_token: csrf }, 200, { 'Set-Cookie': cookie });
  });

  // ---- owner recovery with a one-time code ----
  r.post('/auth/recover', async (ctx) => {
    const e = typeof ctx.body.email === 'string' ? ctx.body.email.trim().toLowerCase() : '';
    const keys = [`recover:ip:${ctx.ip}`, `recover:email:${e}`];
    await assertNotLimited(ctx, keys[0], 10, 3600_000, 'Too many recovery attempts. Try again in an hour.');
    await assertNotLimited(ctx, keys[1], 5, 3600_000, 'Too many recovery attempts for this account. Try again in an hour.');
    await recordAttempt(ctx, ...keys); // every attempt counts, successful or not
    const pw = password(ctx.body.new_password, 'New password');
    const newPin = ctx.body.new_pin ? pin(ctx.body.new_pin, 'New PIN') : null;
    const code = typeof ctx.body.code === 'string' ? normaliseRecoveryCode(ctx.body.code) : '';
    const owner = e && code.length === 16 ? await ctx.env.DB.prepare(
      `SELECT o.* FROM owner_accounts o JOIN businesses b ON b.id = o.business_id WHERE o.email = ? AND o.disabled = 0 AND b.disabled = 0`,
    ).bind(e).first<{ id: string; business_id: string; staff_id: string }>() : null;
    const failed = () => new HttpError(401, 'That email and recovery code do not match an unused code.', 'BAD_RECOVERY_CODE');
    if (!owner) throw failed();
    const db = ctx.env.DB;
    const used = await db.prepare('UPDATE recovery_codes SET used_at = ? WHERE owner_id = ? AND code_hash = ? AND used_at IS NULL')
      .bind(ctx.now, owner.id, await hmac(ctx.env.AUTH_PEPPER, `recovery:${code}`)).run();
    if (used.meta.changes !== 1) throw failed();

    const hash = await hashSecret(pw, ctx.env.AUTH_PEPPER);
    const fresh = await recoveryCodeStatements(ctx, owner.business_id, owner.id);
    const ownerStaff = { id: owner.staff_id, name: 'Owner (recovery)' };
    await db.batch([
      db.prepare('UPDATE owner_accounts SET password_hash = ?, password_changed_at = ? WHERE id = ?').bind(hash, ctx.now, owner.id),
      // Old codes are all retired; a new set replaces them.
      db.prepare('UPDATE recovery_codes SET used_at = ? WHERE owner_id = ? AND used_at IS NULL').bind(ctx.now, owner.id),
      ...fresh.stmts,
      db.prepare('DELETE FROM sessions WHERE owner_id = ?').bind(owner.id),
      ...(newPin ? [db.prepare(`UPDATE staff SET pin_hash = ?, pin_failures = 0, pin_locked_until = NULL, pin_must_change = 0,
                                session_epoch = session_epoch + 1, updated_at = ? WHERE id = ? AND business_id = ?`)
        .bind(await hashSecret(newPin, ctx.env.AUTH_PEPPER), ctx.now, owner.staff_id, owner.business_id)] : []),
      auditStmt(ctx, { businessId: owner.business_id, action: 'owner.recovered', staff: ownerStaff, after: { pin_reset: !!newPin } }),
    ]);
    const staff = (await staffRow(ctx, owner.staff_id, owner.business_id))!;
    const { cookie, csrf } = await createSession(ctx, owner.business_id, owner.id, { staff, reauth: true });
    return json({ ok: true, recovery_codes: fresh.codes, csrf_token: csrf }, 200, { 'Set-Cookie': cookie });
  });

  r.get('/auth/recovery-codes', async (ctx) => {
    await requireOwner(ctx);
    const row = await ctx.env.DB.prepare(
      'SELECT COUNT(*) AS remaining, MAX(created_at) AS created_at FROM recovery_codes WHERE owner_id = ? AND used_at IS NULL',
    ).bind(ctx.session!.owner_id).first<{ remaining: number; created_at: number | null }>();
    return json(row);
  });

  r.post('/auth/recovery-codes', async (ctx) => {
    await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    const s = ctx.session!;
    const db = ctx.env.DB;
    const fresh = await recoveryCodeStatements(ctx, s.business_id, s.owner_id);
    await db.batch([
      db.prepare('UPDATE recovery_codes SET used_at = ? WHERE owner_id = ? AND used_at IS NULL').bind(ctx.now, s.owner_id),
      ...fresh.stmts,
      auditStmt(ctx, { businessId: s.business_id, action: 'owner.recovery_codes_replaced' }),
    ]);
    return json({ recovery_codes: fresh.codes });
  });

  /** Owner forgot their PIN: re-enter the business password to set a new one. */
  r.post('/staff/owner-pin-reset', async (ctx) => {
    const s = await requireBusiness(ctx);
    checkCsrf(ctx);
    const key = `reauth:${s.owner_id}`;
    await assertNotLimited(ctx, key, 5, 15 * 60_000, 'Too many wrong passwords. Please wait 15 minutes.');
    const owner = await ctx.env.DB.prepare('SELECT password_hash, staff_id FROM owner_accounts WHERE id = ?').bind(s.owner_id).first<{ password_hash: string; staff_id: string }>();
    if (!owner || typeof ctx.body.password !== 'string' || !(await verifySecret(ctx.body.password, owner.password_hash, ctx.env.AUTH_PEPPER))) {
      await recordAttempt(ctx, key);
      throw new HttpError(401, 'Password is not correct.', 'BAD_CREDENTIALS');
    }
    const newPin = pin(ctx.body.new_pin, 'New PIN');
    const db = ctx.env.DB;
    await db.batch([
      db.prepare(`UPDATE staff SET pin_hash = ?, pin_failures = 0, pin_locked_until = NULL, pin_must_change = 0,
                  session_epoch = session_epoch + 1, updated_at = ? WHERE id = ? AND business_id = ?`)
        .bind(await hashSecret(newPin, ctx.env.AUTH_PEPPER), ctx.now, owner.staff_id, s.business_id),
      auditStmt(ctx, { businessId: s.business_id, action: 'staff.pin_reset', entityType: 'staff', entityId: owner.staff_id, staff: { id: owner.staff_id, name: 'Owner' }, reason: 'Owner reset own PIN with business password' }),
    ]);
    return json({ ok: true });
  });

}
