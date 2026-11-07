// WebCrypto helpers (work on Cloudflare Workers and in tests).

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 100_000; // Workers' WebCrypto maximum for PBKDF2

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const hex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const randomToken = (n = 32) => b64url(randomBytes(n));

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function pbkdf2(secret: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/**
 * Hash a password or PIN. The secret is first keyed with a server-side pepper
 * (AUTH_PEPPER, a Cloudflare secret), so a stolen database alone cannot be
 * brute-forced — this matters for 6-digit PINs.
 */
export async function hashSecret(secret: string, pepper: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const peppered = await hmac(pepper, secret);
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${await pbkdf2(peppered, salt, iterations)}`;
}

export async function verifySecret(secret: string, stored: string, pepper: string): Promise<boolean> {
  const [kind, iter, salt, expected] = stored.split('$');
  if (kind !== 'pbkdf2-sha256' || !iter || !salt || !expected) return false;
  const peppered = await hmac(pepper, secret);
  return safeEqual(await pbkdf2(peppered, fromB64url(salt), Number(iter)), expected);
}

// ---- AES-GCM for Google tokens at rest ----

async function aesKey(keyB64: string | undefined): Promise<CryptoKey> {
  if (!keyB64) throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
  const raw = fromB64url(keyB64.trim());
  if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypts with AES-256-GCM. `context` (e.g. business id) is bound as additional data. */
export async function encryptString(plain: string, keyB64: string | undefined, context: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, await aesKey(keyB64), enc.encode(plain));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function decryptString(box: string, keyB64: string | undefined, context: string): Promise<string> {
  const [v, iv, ct] = box.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('Bad ciphertext');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv), additionalData: enc.encode(context) }, await aesKey(keyB64), fromB64url(ct));
  return dec.decode(pt);
}

/** Recovery code like "K7QM-2XRP-9VDA-H3TB" (80 bits, no ambiguous characters). */
export function newRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % 32];
  return out.match(/.{4}/g)!.join('-');
}
export const normaliseRecoveryCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
