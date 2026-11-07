export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export const bad = (message: string, code = 'INVALID') => new HttpError(400, message, code);
export const notFound = (what = 'Not found') => new HttpError(404, what, 'NOT_FOUND');
export const forbidden = (message = 'You do not have permission to do this.', code = 'FORBIDDEN') => new HttpError(403, message, code);

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message, code: err.code ?? 'ERROR', ...(err.extra ?? {}) }, err.status);
  }
  // Never log request bodies, tokens or customer data: only the error type/message.
  console.error('Unhandled error:', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown');
  return json({ error: 'Something went wrong. Please try again.', code: 'SERVER_ERROR' }, 500);
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Expected a JSON request.', 'UNSUPPORTED_MEDIA_TYPE');
  if (Number(req.headers.get('content-length') || 0) > 256 * 1024) throw new HttpError(413, 'Request too large.', 'TOO_LARGE');
  const text = await req.text();
  if (text.length > 256 * 1024) throw new HttpError(413, 'Request too large.', 'TOO_LARGE');
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw bad('Invalid JSON.');
  }
}

// ---- input helpers ----

export function str(v: unknown, label: string, { max = 200, required = false } = {}): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label} is required.`);
    return null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${label} is invalid.`);
  // Strip control characters (keep newlines/tabs in multi-line text).
  const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!s) {
    if (required) throw bad(`${label} is required.`);
    return null;
  }
  if (s.length > max) throw bad(`${label} is too long (maximum ${max} characters).`);
  return s;
}

/** Indian phone numbers: optional +91 / 0 prefix, 10 digits starting 6-9. Stored as +91XXXXXXXXXX. Other international numbers allowed with +. */
export function phone(v: unknown, label = 'Phone number'): string {
  const raw = str(v, label, { max: 20, required: true })!.replace(/[\s()-]/g, '');
  let m = /^(?:\+91|0091|91|0)?([6-9]\d{9})$/.exec(raw);
  if (m) return `+91${m[1]}`;
  m = /^\+([1-9]\d{7,14})$/.exec(raw);
  if (m) return `+${m[1]}`;
  throw bad(`${label} must be a 10-digit mobile number (with or without +91).`);
}

export function email(v: unknown): string {
  const s = str(v, 'Email', { max: 200, required: true })!.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('Enter a valid email address.');
  return s;
}

export function password(v: unknown, label = 'Password'): string {
  if (typeof v !== 'string' || v.length < 10) throw bad(`${label} must be at least 10 characters.`);
  if (v.length > 200) throw bad(`${label} is too long.`);
  return v;
}

export function pin(v: unknown, label = 'PIN'): string {
  if (typeof v !== 'string' || !/^\d{6}$/.test(v)) throw bad(`${label} must be exactly 6 digits.`);
  if (/^(\d)\1{5}$/.test(v) || v === '123456' || v === '654321') throw bad(`${label} is too easy to guess. Choose another.`);
  return v;
}

export function intParam(v: string | null, def: number, min: number, max: number): number {
  const n = v === null ? def : Number(v);
  if (!Number.isInteger(n)) return def;
  return Math.min(max, Math.max(min, n));
}
