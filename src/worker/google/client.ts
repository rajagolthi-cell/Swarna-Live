// Minimal Google OAuth / Drive v3 / Sheets v4 client using fetch.
// Endpoints match Google's official client libraries (google-auth-library,
// @googleapis/drive, @googleapis/sheets). No customer data or tokens are logged.

import type { Env } from '../env';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/** drive.file: only files and folders this app creates. spreadsheets: read/write the sheet the owner chooses. */
export const SCOPE_DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
export const SCOPE_SHEETS = 'https://www.googleapis.com/auth/spreadsheets';
export const GOOGLE_SCOPES = ['openid', 'email', SCOPE_DRIVE_FILE, SCOPE_SHEETS];

/** Replaceable in tests. */
export const googleDeps: { fetch: typeof fetch } = { fetch: (input, init) => fetch(input, init) };

export class GoogleError extends Error {
  constructor(
    public kind: 'auth_revoked' | 'unauthorized' | 'forbidden' | 'not_found' | 'transient' | 'bad_request' | 'config',
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

export const redirectUri = (env: Env) => `${env.APP_ORIGIN.replace(/\/$/, '')}/api/google/callback`;

export function googleConfigured(env: Env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY);
}

export function buildAuthUrl(env: Env, state: string, codeChallenge: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTH_URL}?${p}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await googleDeps.fetch(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  } catch {
    throw new GoogleError('transient', 'Could not reach Google.');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new GoogleError('auth_revoked', 'Google access was revoked or expired. Please reconnect Google.', res.status);
    if (res.status >= 500 || res.status === 429) throw new GoogleError('transient', 'Google is temporarily unavailable.', res.status);
    throw new GoogleError('bad_request', `Google rejected the request (${String(data.error ?? res.status)}).`, res.status);
  }
  return data as unknown as TokenResponse;
}

export function exchangeCode(env: Env, code: string, verifier: string) {
  return tokenRequest(new URLSearchParams({
    code, code_verifier: verifier, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: redirectUri(env), grant_type: 'authorization_code',
  }));
}

export function refreshAccessToken(env: Env, refreshToken: string) {
  return tokenRequest(new URLSearchParams({
    refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, grant_type: 'refresh_token',
  }));
}

export async function revokeToken(token: string) {
  try {
    await googleDeps.fetch(GOOGLE_REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
  } catch { /* best effort: the stored token is deleted either way */ }
}

/** Reads the email claim from an ID token received directly from Google's token endpoint over TLS. */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

async function api<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await googleDeps.fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  } catch {
    throw new GoogleError('transient', 'Could not reach Google.');
  }
  if (res.ok) return (res.status === 204 ? ({} as T) : ((await res.json()) as T));
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
  const msg = data.error?.status ?? `HTTP ${res.status}`;
  if (res.status === 401) throw new GoogleError('unauthorized', 'Google sign-in expired.', 401);
  if (res.status === 403 && /rate|quota/i.test(data.error?.message ?? '')) throw new GoogleError('transient', 'Google rate limit reached.', 403);
  if (res.status === 403) throw new GoogleError('forbidden', 'The connected Google account does not have permission for this destination.', 403);
  if (res.status === 404) throw new GoogleError('not_found', 'The Google Drive folder or spreadsheet was not found (or Swarna Live cannot see it).', 404);
  if (res.status === 429 || res.status >= 500) throw new GoogleError('transient', 'Google is temporarily unavailable.', res.status);
  throw new GoogleError('bad_request', `Google rejected the request (${msg}).`, res.status);
}

// ---- Drive ----

export interface DriveFile { id: string; name?: string; mimeType?: string; trashed?: boolean; webViewLink?: string; capabilities?: { canAddChildren?: boolean; canEdit?: boolean } }
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function driveGet(token: string, id: string) {
  const q = new URLSearchParams({ fields: 'id,name,mimeType,trashed,webViewLink,capabilities(canAddChildren,canEdit)', supportsAllDrives: 'true' });
  return api<DriveFile>(token, `${DRIVE}/files/${encodeURIComponent(id)}?${q}`);
}

export function driveCreateFolder(token: string, name: string, parentId: string | null, appProperties: Record<string, string>) {
  return api<DriveFile>(token, `${DRIVE}/files?fields=id,name,webViewLink&supportsAllDrives=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}), appProperties }),
  });
}

/** Finds a file this app created earlier, tagged with appProperties key=value. */
export async function driveFindByProperty(token: string, key: string, value: string, parentId?: string): Promise<DriveFile | null> {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  let q = `appProperties has { key='${esc(key)}' and value='${esc(value)}' } and trashed = false`;
  if (parentId) q += ` and '${esc(parentId)}' in parents`;
  const p = new URLSearchParams({ q, fields: 'files(id,name,webViewLink)', pageSize: '5', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
  const res = await api<{ files: DriveFile[] }>(token, `${DRIVE}/files?${p}`);
  return res.files?.[0] ?? null;
}

export async function driveUpload(token: string, meta: { name: string; parents: string[]; appProperties: Record<string, string>; description?: string }, bytes: ArrayBuffer, contentType: string) {
  const boundary = `swarna${crypto.randomUUID().replace(/-/g, '')}`;
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ ...meta, mimeType: contentType })}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Blob([head, bytes, tail]);
  return api<DriveFile>(token, `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
}

// ---- Sheets ----

export interface SheetProps { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } }

export function sheetsGet(token: string, spreadsheetId: string) {
  return api<{ spreadsheetId: string; properties: { title: string }; sheets: { properties: SheetProps }[] }>(
    token, `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties.title,sheets.properties(sheetId,title,gridProperties)`);
}

export const a1 = (title: string, range: string) => `'${title.replace(/'/g, "''")}'!${range}`;

export function valuesGet(token: string, spreadsheetId: string, range: string) {
  return api<{ values?: (string | number)[][] }>(token, `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`);
}

/** RAW: values are stored exactly as given; text starting with "=" stays text and is never run as a formula. */
export function valuesUpdate(token: string, spreadsheetId: string, range: string, values: (string | number)[][]) {
  return api<{ updatedRange?: string }>(token, `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
  });
}

export function valuesAppend(token: string, spreadsheetId: string, range: string, values: (string | number)[][]) {
  return api<{ updates?: { updatedRange?: string } }>(token,
    `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
    });
}

export async function addSheet(token: string, spreadsheetId: string, title: string): Promise<SheetProps> {
  const res = await api<{ replies: { addSheet: { properties: SheetProps } }[] }>(token, `${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] }),
  });
  return res.replies[0].addSheet.properties;
}

// ---- links ----

/** Accepts only Google Drive folder links (or a bare ID). Never fetches the URL. */
export function parseDriveFolderId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{10,200}$/.test(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'drive.google.com') return null;
  const m = /^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,200})\/?$/.exec(u.pathname);
  return m ? m[1] : null;
}

/** Accepts only Google Sheets links (or a bare ID). Returns the spreadsheet id and the gid in the link if any. */
export function parseSpreadsheetUrl(input: string): { id: string; gid: number | null } | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{20,200}$/.test(s)) return { id: s, gid: null };
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return null;
  const m = /^\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,200})(?:\/.*)?$/.exec(u.pathname);
  if (!m) return null;
  const g = /(?:^|[#&?])gid=(\d+)/.exec(u.hash + '&' + u.search);
  return { id: m[1], gid: g ? Number(g[1]) : null };
}

export const folderLink = (id: string) => `https://drive.google.com/drive/folders/${id}`;
export const sheetLink = (id: string, gid?: number | null) => `https://docs.google.com/spreadsheets/d/${id}/edit${gid != null ? `#gid=${gid}` : ''}`;
