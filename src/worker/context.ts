import type { Env } from './env';
import { HttpError, forbidden } from './http';
import { randomToken, sha256, safeEqual } from './crypto';
import { effectivePermissions, type Permission, type Role } from '../shared/permissions';

export const REAUTH_WINDOW_MS = 10 * 60 * 1000;
const ACTIVITY_WRITE_INTERVAL_MS = 30 * 1000;

export interface SessionRow {
  id_hash: string;
  business_id: string;
  owner_id: string;
  csrf_token: string;
  expires_at: number;
  staff_id: string | null;
  staff_epoch: number | null;
  staff_active_at: number | null;
  reauth_at: number | null;
  // joined
  business_name: string;
  profile_lock_minutes: number;
  session_hours: number;
  owner_email: string;
  owner_staff_id: string;
}

export interface StaffRow {
  id: string;
  business_id: string;
  name: string;
  role: Role;
  permissions: string;
  pin_hash: string;
  pin_must_change: number;
  pin_failures: number;
  pin_locked_until: number | null;
  disabled: number;
  session_epoch: number;
}

export interface ActiveStaff {
  id: string;
  name: string;
  role: Role;
  permissions: Permission[];
  pinMustChange: boolean;
}

export interface Ctx {
  req: Request;
  env: Env;
  exec: ExecutionContext;
  url: URL;
  params: Record<string, string>;
  ip: string;
  now: number;
  body: Record<string, unknown>;
  session?: SessionRow;
  staff?: ActiveStaff;
  /** Set when the staff profile was locked because of inactivity on this request. */
  staffLockedReason?: 'inactive' | 'revoked' | null;
}

// ---------- cookies ----------

export function cookieName(env: Env) {
  return env.COOKIE_SECURE === 'false' ? 'swarna_session' : '__Host-swarna_session';
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(env: Env, token: string, maxAgeSeconds: number): string {
  const secure = env.COOKIE_SECURE === 'false' ? '' : '; Secure';
  return `${cookieName(env)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}
export const clearCookie = (env: Env) => sessionCookie(env, '', 0);

// ---------- sessions ----------

export async function createSession(ctx: Ctx, businessId: string, ownerId: string, opts: { staff?: StaffRow; reauth?: boolean } = {}) {
  const b = await ctx.env.DB.prepare('SELECT session_hours FROM businesses WHERE id = ?').bind(businessId).first<{ session_hours: number }>();
  const hours = b?.session_hours ?? 12;
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = ctx.now;
  await ctx.env.DB.prepare(
    `INSERT INTO sessions (id_hash, business_id, owner_id, csrf_token, created_at, expires_at, staff_id, staff_epoch, staff_active_at, reauth_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(await sha256(token), businessId, ownerId, csrf, now, now + hours * 3600_000,
    opts.staff?.id ?? null, opts.staff?.session_epoch ?? null, opts.staff ? now : null, opts.reauth ? now : null).run();
  return { cookie: sessionCookie(ctx.env, token, hours * 3600), csrf };
}

export async function loadSession(ctx: Ctx): Promise<SessionRow | null> {
  const token = readCookie(ctx.req, cookieName(ctx.env));
  if (!token || token.length > 100) return null;
  const row = await ctx.env.DB.prepare(
    `SELECT s.*, b.name AS business_name, b.profile_lock_minutes, b.session_hours, o.email AS owner_email, o.staff_id AS owner_staff_id
     FROM sessions s
     JOIN businesses b ON b.id = s.business_id
     JOIN owner_accounts o ON o.id = s.owner_id AND o.business_id = s.business_id
     WHERE s.id_hash = ? AND s.expires_at > ? AND b.disabled = 0 AND o.disabled = 0`,
  ).bind(await sha256(token), ctx.now).first<SessionRow>();
  return row ?? null;
}

export async function requireBusiness(ctx: Ctx): Promise<SessionRow> {
  if (!ctx.session) {
    ctx.session = (await loadSession(ctx)) ?? undefined;
    if (!ctx.session) throw new HttpError(401, 'Please sign in to your business account.', 'NOT_SIGNED_IN');
  }
  return ctx.session;
}

export function checkCsrf(ctx: Ctx) {
  const s = ctx.session!;
  const header = ctx.req.headers.get('x-csrf-token') || '';
  if (!safeEqual(header, s.csrf_token)) throw new HttpError(403, 'Your session token is out of date. Refresh the page and try again.', 'CSRF');
}

/** Returns the unlocked staff profile, or null (and records why) if none is active. */
export async function resolveStaff(ctx: Ctx): Promise<ActiveStaff | null> {
  const s = await requireBusiness(ctx);
  if (ctx.staff) return ctx.staff;
  if (!s.staff_id) return null;
  const st = await ctx.env.DB.prepare('SELECT * FROM staff WHERE id = ? AND business_id = ?').bind(s.staff_id, s.business_id).first<StaffRow>();
  const idleLimit = s.profile_lock_minutes * 60_000;
  let reason: 'inactive' | 'revoked' | null = null;
  if (!st || st.disabled || st.session_epoch !== s.staff_epoch) reason = 'revoked';
  else if (!s.staff_active_at || ctx.now - s.staff_active_at > idleLimit) reason = 'inactive';
  if (reason) {
    await ctx.env.DB.prepare('UPDATE sessions SET staff_id = NULL, staff_epoch = NULL, staff_active_at = NULL, reauth_at = NULL WHERE id_hash = ?').bind(s.id_hash).run();
    s.staff_id = null;
    ctx.staffLockedReason = reason;
    return null;
  }
  if (ctx.now - (s.staff_active_at ?? 0) > ACTIVITY_WRITE_INTERVAL_MS) {
    await ctx.env.DB.prepare('UPDATE sessions SET staff_active_at = ? WHERE id_hash = ?').bind(ctx.now, s.id_hash).run();
  }
  ctx.staff = {
    id: st!.id,
    name: st!.name,
    role: st!.role,
    permissions: effectivePermissions(st!.role, JSON.parse(st!.permissions || '[]')),
    pinMustChange: !!st!.pin_must_change,
  };
  return ctx.staff;
}

export async function requireStaff(ctx: Ctx, { allowPinChange = false } = {}): Promise<ActiveStaff> {
  const st = await resolveStaff(ctx);
  if (!st) {
    throw new HttpError(401, ctx.staffLockedReason === 'inactive'
      ? 'Your profile was locked after a period of inactivity. Enter your PIN to continue.'
      : 'Choose your staff profile and enter your PIN.', 'PROFILE_LOCKED');
  }
  if (st.pinMustChange && !allowPinChange) throw new HttpError(403, 'Please set a new PIN before continuing.', 'PIN_CHANGE_REQUIRED');
  return st;
}

export async function requirePerm(ctx: Ctx, perm: Permission): Promise<ActiveStaff> {
  const st = await requireStaff(ctx);
  if (!st.permissions.includes(perm)) throw forbidden();
  return st;
}

export async function requireOwner(ctx: Ctx): Promise<ActiveStaff> {
  const st = await requireStaff(ctx);
  if (st.role !== 'owner') throw forbidden('Only the owner can do this.');
  return st;
}

/** Owner who re-entered the business password within the last 10 minutes. */
export async function requireRecentOwnerAuth(ctx: Ctx): Promise<ActiveStaff> {
  const st = await requireOwner(ctx);
  const at = ctx.session!.reauth_at;
  if (!at || ctx.now - at > REAUTH_WINDOW_MS) {
    throw new HttpError(403, 'For your security, please confirm your business password.', 'REAUTH_REQUIRED');
  }
  return st;
}

export const can = (st: ActiveStaff | undefined, p: Permission) => !!st && st.permissions.includes(p);

// ---------- rate limiting ----------

/** Throws 429 if `key` already has `max` entries within `windowMs`. */
export async function assertNotLimited(ctx: Ctx, key: string, max: number, windowMs: number, message: string) {
  const row = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ? AND at > ?')
    .bind(key, ctx.now - windowMs).first<{ n: number }>();
  if ((row?.n ?? 0) >= max) throw new HttpError(429, message, 'RATE_LIMITED');
}
export async function recordAttempt(ctx: Ctx, ...keys: string[]) {
  const stmt = ctx.env.DB.prepare('INSERT INTO rate_limits (key, at) VALUES (?, ?)');
  await ctx.env.DB.batch(keys.map((k) => stmt.bind(k, ctx.now)));
}

// ---------- audit ----------

export function auditStmt(ctx: Ctx, a: {
  businessId: string; action: string; entityType?: string; entityId?: string; reason?: string | null;
  before?: unknown; after?: unknown; staff?: { id: string; name: string } | null;
}): D1PreparedStatement {
  const st = a.staff === undefined ? ctx.staff : a.staff;
  return ctx.env.DB.prepare(
    `INSERT INTO audit_log (id, business_id, staff_id, staff_name, action, entity_type, entity_id, reason, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), a.businessId, st?.id ?? null, st?.name ?? null, a.action, a.entityType ?? null, a.entityId ?? null,
    a.reason ?? null, a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after), ctx.now);
}
