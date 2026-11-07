import type { Ctx, StaffRow } from '../context';
import {
  assertNotLimited, auditStmt, checkCsrf, recordAttempt, requireBusiness, requireRecentOwnerAuth, requireStaff, requireOwner,
} from '../context';
import { hashSecret, verifySecret } from '../crypto';
import { HttpError, bad, forbidden, json, notFound, pin, str } from '../http';
import type { Router } from '../router';
import { DEFAULT_PERMISSIONS, GRANTABLE, type Permission, type Role } from '../../shared/permissions';

const MAX_PIN_FAILURES = 5;
const PIN_LOCK_MS = 15 * 60_000;

function publicStaff(s: StaffRow, now: number) {
  return {
    id: s.id, name: s.name, role: s.role, permissions: JSON.parse(s.permissions || '[]') as string[],
    disabled: !!s.disabled, pin_must_change: !!s.pin_must_change,
    locked_until: s.pin_locked_until && s.pin_locked_until > now ? s.pin_locked_until : null,
  };
}

function readPermissions(role: Exclude<Role, 'owner'>, v: unknown): Permission[] {
  if (v === undefined) return DEFAULT_PERMISSIONS[role];
  if (!Array.isArray(v)) throw bad('Permissions must be a list.');
  const allowed = GRANTABLE[role];
  for (const p of v) if (typeof p !== 'string' || !allowed.includes(p as Permission)) throw bad(`Permission "${String(p)}" cannot be given to this role.`);
  return [...new Set(v as Permission[])];
}

function readRole(v: unknown): Exclude<Role, 'owner'> {
  if (v !== 'admin' && v !== 'employee') throw bad('Role must be Admin or Employee.');
  return v;
}

async function loadStaff(ctx: Ctx, id: string) {
  const s = await ctx.env.DB.prepare('SELECT * FROM staff WHERE id = ? AND business_id = ?').bind(id, ctx.session!.business_id).first<StaffRow>();
  if (!s) throw notFound('Staff profile not found.');
  return s;
}

/** Forces every device using this profile to lock (epoch bump) and clears the unlocked sessions. */
function revokeStatements(ctx: Ctx, staffId: string) {
  const db = ctx.env.DB;
  return [
    db.prepare('UPDATE staff SET session_epoch = session_epoch + 1, updated_at = ? WHERE id = ? AND business_id = ?').bind(ctx.now, staffId, ctx.session!.business_id),
    db.prepare('UPDATE sessions SET staff_id = NULL, staff_epoch = NULL, staff_active_at = NULL, reauth_at = NULL WHERE staff_id = ? AND business_id = ?').bind(staffId, ctx.session!.business_id),
  ];
}

export function staffRoutes(r: Router) {
  /** Profiles shown on the selector after business sign-in. */
  r.get('/staff/profiles', async (ctx) => {
    const s = await requireBusiness(ctx);
    const rows = await ctx.env.DB.prepare(
      `SELECT * FROM staff WHERE business_id = ? AND disabled = 0
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name COLLATE NOCASE LIMIT 200`,
    ).bind(s.business_id).all<StaffRow>();
    return json(rows.results.map((x) => {
      const p = publicStaff(x, ctx.now);
      return { id: p.id, name: p.name, role: p.role, locked_until: p.locked_until };
    }));
  });

  r.post('/staff/unlock', async (ctx) => {
    const s = await requireBusiness(ctx);
    checkCsrf(ctx);
    const sessionKey = `pin:session:${s.id_hash}`;
    await assertNotLimited(ctx, sessionKey, 15, 15 * 60_000, 'Too many PIN attempts on this device. Please wait 15 minutes.');
    const id = typeof ctx.body.staff_id === 'string' ? ctx.body.staff_id : '';
    const st = id && await ctx.env.DB.prepare('SELECT * FROM staff WHERE id = ? AND business_id = ? AND disabled = 0').bind(id, s.business_id).first<StaffRow>();
    if (!st) throw notFound('Staff profile not found.');
    if (st.pin_locked_until && st.pin_locked_until > ctx.now) {
      throw new HttpError(423, 'This profile is locked after too many wrong PINs. Try again later or ask the owner.', 'PIN_LOCKED', { locked_until: st.pin_locked_until });
    }
    const entered = typeof ctx.body.pin === 'string' && /^\d{6}$/.test(ctx.body.pin) ? ctx.body.pin : null;
    const db = ctx.env.DB;
    if (!entered || !(await verifySecret(entered, st.pin_hash, ctx.env.AUTH_PEPPER))) {
      await recordAttempt(ctx, sessionKey);
      const failures = st.pin_failures + 1;
      const lock = failures >= MAX_PIN_FAILURES;
      await db.batch([
        db.prepare('UPDATE staff SET pin_failures = ?, pin_locked_until = ? WHERE id = ? AND business_id = ?')
          .bind(lock ? 0 : failures, lock ? ctx.now + PIN_LOCK_MS : st.pin_locked_until, st.id, s.business_id),
        ...(lock ? [auditStmt(ctx, { businessId: s.business_id, action: 'staff.pin_lockout', entityType: 'staff', entityId: st.id, staff: null })] : []),
      ]);
      if (lock) throw new HttpError(423, 'Too many wrong PINs. This profile is locked for 15 minutes.', 'PIN_LOCKED', { locked_until: ctx.now + PIN_LOCK_MS });
      throw new HttpError(401, `Wrong PIN. ${MAX_PIN_FAILURES - failures} ${MAX_PIN_FAILURES - failures === 1 ? 'try' : 'tries'} left before the profile locks.`, 'BAD_PIN');
    }
    await db.batch([
      db.prepare('UPDATE staff SET pin_failures = 0, pin_locked_until = NULL WHERE id = ? AND business_id = ?').bind(st.id, s.business_id),
      db.prepare('UPDATE sessions SET staff_id = ?, staff_epoch = ?, staff_active_at = ?, reauth_at = NULL WHERE id_hash = ?')
        .bind(st.id, st.session_epoch, ctx.now, s.id_hash),
    ]);
    return json({ ok: true, pin_must_change: !!st.pin_must_change });
  });

  /** "Switch profile": lock the current staff profile, keep the business session. */
  r.post('/staff/lock', async (ctx) => {
    const s = await requireBusiness(ctx);
    checkCsrf(ctx);
    await ctx.env.DB.prepare('UPDATE sessions SET staff_id = NULL, staff_epoch = NULL, staff_active_at = NULL, reauth_at = NULL WHERE id_hash = ?').bind(s.id_hash).run();
    return json({ ok: true });
  });

  /** Change your own PIN (also used after the owner resets it). */
  r.post('/staff/me/pin', async (ctx) => {
    const me = await requireStaff(ctx, { allowPinChange: true });
    checkCsrf(ctx);
    const s = ctx.session!;
    const row = await loadStaff(ctx, me.id);
    if (!row.pin_must_change) {
      if (typeof ctx.body.current_pin !== 'string' || !(await verifySecret(ctx.body.current_pin, row.pin_hash, ctx.env.AUTH_PEPPER))) {
        throw new HttpError(401, 'Current PIN is not correct.', 'BAD_PIN');
      }
    }
    const newPin = pin(ctx.body.new_pin, 'New PIN');
    const db = ctx.env.DB;
    await db.batch([
      db.prepare('UPDATE staff SET pin_hash = ?, pin_must_change = 0, updated_at = ? WHERE id = ? AND business_id = ?')
        .bind(await hashSecret(newPin, ctx.env.AUTH_PEPPER), ctx.now, me.id, s.business_id),
      auditStmt(ctx, { businessId: s.business_id, action: 'staff.pin_changed', entityType: 'staff', entityId: me.id }),
    ]);
    return json({ ok: true });
  });

  // ---- owner: staff management ----
  r.get('/staff', async (ctx) => {
    await requireOwner(ctx);
    const rows = await ctx.env.DB.prepare(
      `SELECT * FROM staff WHERE business_id = ? ORDER BY disabled, CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name COLLATE NOCASE LIMIT 500`,
    ).bind(ctx.session!.business_id).all<StaffRow>();
    return json(rows.results.map((x) => publicStaff(x, ctx.now)));
  });

  r.post('/staff', async (ctx) => {
    await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    const s = ctx.session!;
    const name = str(ctx.body.name, 'Name', { required: true, max: 80 })!;
    const role = readRole(ctx.body.role);
    const perms = readPermissions(role, ctx.body.permissions);
    const newPin = pin(ctx.body.pin);
    const id = crypto.randomUUID();
    const db = ctx.env.DB;
    await db.batch([
      db.prepare(`INSERT INTO staff (id, business_id, name, role, permissions, pin_hash, pin_must_change, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(id, s.business_id, name, role, JSON.stringify(perms), await hashSecret(newPin, ctx.env.AUTH_PEPPER), ctx.now, ctx.now),
      auditStmt(ctx, { businessId: s.business_id, action: 'staff.created', entityType: 'staff', entityId: id, after: { name, role, permissions: perms } }),
    ]);
    return json({ id }, 201);
  });

  r.put('/staff/:id', async (ctx) => {
    await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    const s = ctx.session!;
    const st = await loadStaff(ctx, ctx.params.id);
    if (st.role === 'owner') throw forbidden('The owner profile always has full access.');
    const name = str(ctx.body.name, 'Name', { required: true, max: 80 })!;
    const role = readRole(ctx.body.role);
    const perms = readPermissions(role, ctx.body.permissions ?? []);
    const before = { name: st.name, role: st.role, permissions: JSON.parse(st.permissions) };
    const after = { name, role, permissions: perms };
    const db = ctx.env.DB;
    await db.batch([
      db.prepare('UPDATE staff SET name = ?, role = ?, permissions = ?, updated_at = ? WHERE id = ? AND business_id = ?')
        .bind(name, role, JSON.stringify(perms), ctx.now, st.id, s.business_id),
      auditStmt(ctx, { businessId: s.business_id, action: 'staff.updated', entityType: 'staff', entityId: st.id, before, after }),
    ]);
    return json({ ok: true });
  });

  r.post('/staff/:id/disable', async (ctx) => {
    await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    const s = ctx.session!;
    const st = await loadStaff(ctx, ctx.params.id);
    if (st.role === 'owner') throw forbidden('The owner profile cannot be disabled.');
    const reason = str(ctx.body.reason, 'Reason', { max: 300 });
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE staff SET disabled = 1, updated_at = ? WHERE id = ? AND business_id = ?').bind(ctx.now, st.id, s.business_id),
      ...revokeStatements(ctx, st.id),
      auditStmt(ctx, { businessId: s.business_id, action: 'staff.disabled', entityType: 'staff', entityId: st.id, reason }),
    ]);
    return json({ ok: true });
  });

  r.post('/staff/:id/enable', async (ctx) => {
    await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    const s = ctx.session!;
    const st = await loadStaff(ctx, ctx.params.id);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE staff SET disabled = 0, pin_failures = 0, pin_locked_until = NULL, updated_at = ? WHERE id = ? AND business_id = ?').bind(ctx.now, st.id, s.business_id),
      auditStmt(ctx, { businessId: s.business_id, action: 'staff.enabled', entityType: 'staff', entityId: st.id }),
    ]);
    return json({ ok: true });
  });

  /** Owner sets a temporary PIN; the staff member must choose a new one at next unlock. */
  r.post('/staff/:id/reset-pin', async (ctx) => {
    await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    const s = ctx.session!;
    const st = await loadStaff(ctx, ctx.params.id);
    if (st.role === 'owner') throw forbidden('Change your own PIN from Settings.');
    const tempPin = pin(ctx.body.pin, 'Temporary PIN');
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`UPDATE staff SET pin_hash = ?, pin_must_change = 1, pin_failures = 0, pin_locked_until = NULL, updated_at = ?
                          WHERE id = ? AND business_id = ?`).bind(await hashSecret(tempPin, ctx.env.AUTH_PEPPER), ctx.now, st.id, s.business_id),
      ...revokeStatements(ctx, st.id),
      auditStmt(ctx, { businessId: s.business_id, action: 'staff.pin_reset', entityType: 'staff', entityId: st.id }),
    ]);
    return json({ ok: true });
  });

  /** Sign this profile out on every device. */
  r.post('/staff/:id/revoke', async (ctx) => {
    await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    const s = ctx.session!;
    const st = await loadStaff(ctx, ctx.params.id);
    await ctx.env.DB.batch([
      ...revokeStatements(ctx, st.id),
      auditStmt(ctx, { businessId: s.business_id, action: 'staff.sessions_revoked', entityType: 'staff', entityId: st.id }),
    ]);
    return json({ ok: true });
  });
}
