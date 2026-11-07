// Durable Google Drive / Sheets synchronisation.
//
// Cloudflare D1 + R2 hold the primary records. Each saved quote gets one
// `sync_jobs` row per destination, written in the SAME D1 transaction as the
// quote, so no save can be "forgotten". Jobs are then run:
//   - right after the save (Queue message if SYNC_QUEUE is bound, else waitUntil)
//   - by the cron trigger, which picks up anything due (covers lost messages)
// A job is leased before it runs, so two runners never work on it at once.
// Duplicates are prevented by: the stored Drive file id + an appProperties
// tag on every uploaded file, and an immutable record-id column in the sheet.
// This gives at-least-once attempts with duplicate prevention, not exactly-once.

import type { Env } from '../env';
import { decryptString, encryptString } from '../crypto';
import {
  GoogleError, a1, driveCreateFolder, driveFindByProperty, driveGet, driveUpload, refreshAccessToken, sheetsGet, valuesAppend, valuesGet, valuesUpdate,
} from './client';
import { formatIST, istParts } from '../../shared/time';
import type { QuoteRow } from '../routes/quotes';

export const MAX_ATTEMPTS = 8;
const LEASE_MS = 120_000;
const SHEET_LOCK_MS = 60_000;

export const SHEET_HEADERS = [
  'Order Number', 'Date/Time IST', 'Staff Name', 'Customer Name', 'Phone Number', 'Metal', 'Item Type', 'Description', 'Purity',
  'Gross Weight (g)', 'Deduction (g)', 'Net Weight (g)', 'Rate Per Gram (INR)', 'Assessed Value (INR)', 'Buyback Percentage (%)',
  'Estimated Offer (INR)', 'Status', 'Notes', 'Photo Link', 'Swarna Live Record ID (do not edit)',
];
export const LAST_COL = 'T';
export const ID_COL = 'T';

export interface ConnectionRow {
  business_id: string; status: 'connected' | 'reconnect_required' | 'disconnected'; google_email: string | null; scopes: string | null;
  refresh_token_enc: string | null; access_token_enc: string | null; access_expires_at: number | null; last_error: string | null;
  drive_folder_id: string | null; drive_folder_name: string | null; spreadsheet_id: string | null; spreadsheet_title: string | null;
  sheet_id: number | null; sheet_title: string | null; last_sync_at: number | null; connected_at: number | null; destinations_at: number | null;
}

interface JobRow {
  id: string; business_id: string; quote_id: string; kind: 'drive' | 'sheet'; status: string; version: number; synced_version: number;
  attempts: number; drive_file_id: string | null; drive_link: string | null; spreadsheet_id: string | null; sheet_id: number | null; sheet_row: number | null;
}

// ---------- statements used by the quote routes ----------

/** Creates the sync jobs for a new quote, but only when Google is connected and a destination is set. */
export function newJobStatements(env: Env, businessId: string, quoteId: string, now: number): D1PreparedStatement[] {
  const ins = (kind: 'drive' | 'sheet', cond: string) => env.DB.prepare(
    `INSERT INTO sync_jobs (id, business_id, quote_id, kind, status, next_attempt_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'pending', ?, ?, ? FROM google_connections
     WHERE business_id = ? AND status = 'connected' AND ${cond}
     ON CONFLICT (quote_id, kind) DO NOTHING`,
  ).bind(crypto.randomUUID(), businessId, quoteId, kind, now, now, now, businessId);
  return [ins('drive', 'drive_folder_id IS NOT NULL'), ins('sheet', 'spreadsheet_id IS NOT NULL AND sheet_id IS NOT NULL')];
}

/** The quote changed (status / correction / photo link): the sheet row must be written again. */
export function markSheetDirtyStmt(env: Env, businessId: string, quoteId: string, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE sync_jobs SET version = version + 1, status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'pending' END,
       attempts = 0, last_error = NULL, next_attempt_at = ?, updated_at = ?
     WHERE business_id = ? AND quote_id = ? AND kind = 'sheet'`,
  ).bind(now, now, businessId, quoteId);
}

// ---------- dispatch ----------

export async function dispatch(env: Env, jobIds: string[]) {
  if (!jobIds.length) return;
  if (env.SYNC_QUEUE) {
    // The queue message holds only the internal job id — never tokens or customer data.
    await env.SYNC_QUEUE.sendBatch(jobIds.map((jobId) => ({ body: { jobId } })));
    return;
  }
  for (const id of jobIds) await processJob(env, id);
}

export async function dispatchJobsForQuote(env: Env, businessId: string, quoteId: string) {
  // Drive first ('drive' < 'sheet'), so the sheet row can include the photo link.
  const rows = await env.DB.prepare("SELECT id FROM sync_jobs WHERE business_id = ? AND quote_id = ? AND status = 'pending' ORDER BY kind")
    .bind(businessId, quoteId).all<{ id: string }>();
  await dispatch(env, rows.results.map((r) => r.id));
}

/** Cron safety net: run anything due, including jobs whose queue message was lost. */
export async function runDueJobs(env: Env, now = Date.now(), limit = 25) {
  const rows = await env.DB.prepare(
    `SELECT id FROM sync_jobs WHERE status = 'pending' AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until < ?)
     ORDER BY CASE kind WHEN 'drive' THEN 0 ELSE 1 END, next_attempt_at LIMIT ?`,
  ).bind(now, now, limit).all<{ id: string }>();
  await dispatch(env, rows.results.map((r) => r.id));
  return rows.results.length;
}

// ---------- tokens ----------

export async function getConnection(env: Env, businessId: string) {
  return env.DB.prepare('SELECT * FROM google_connections WHERE business_id = ?').bind(businessId).first<ConnectionRow>();
}

/** Marks the connection as needing reconnection and pauses its open jobs. */
export async function markReconnectRequired(env: Env, businessId: string, message: string, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE google_connections SET status = 'reconnect_required', access_token_enc = NULL, access_expires_at = NULL,
                    last_error = ?, updated_at = ? WHERE business_id = ? AND status = 'connected'`).bind(message, now, businessId),
    env.DB.prepare("UPDATE sync_jobs SET status = 'paused', lease_until = NULL, updated_at = ? WHERE business_id = ? AND status IN ('pending','failed')").bind(now, businessId),
  ]);
}

export async function getAccessToken(env: Env, conn: ConnectionRow, now = Date.now()): Promise<string> {
  if (conn.status !== 'connected' || !conn.refresh_token_enc) throw new GoogleError('auth_revoked', 'Google is not connected.');
  if (conn.access_token_enc && conn.access_expires_at && conn.access_expires_at - 60_000 > now) {
    return decryptString(conn.access_token_enc, env.TOKEN_ENCRYPTION_KEY, `access:${conn.business_id}`);
  }
  const refresh = await decryptString(conn.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY, `refresh:${conn.business_id}`);
  try {
    const t = await refreshAccessToken(env, refresh);
    const enc = await encryptString(t.access_token, env.TOKEN_ENCRYPTION_KEY, `access:${conn.business_id}`);
    const expires = now + t.expires_in * 1000;
    // Google may rotate the refresh token; keep the newest one.
    const newRefresh = t.refresh_token ? await encryptString(t.refresh_token, env.TOKEN_ENCRYPTION_KEY, `refresh:${conn.business_id}`) : null;
    await env.DB.prepare(`UPDATE google_connections SET access_token_enc = ?, access_expires_at = ?, refresh_token_enc = COALESCE(?, refresh_token_enc), updated_at = ?
                          WHERE business_id = ? AND status = 'connected'`).bind(enc, expires, newRefresh, now, conn.business_id).run();
    conn.access_token_enc = enc;
    conn.access_expires_at = expires;
    return t.access_token;
  } catch (e) {
    if (e instanceof GoogleError && e.kind === 'auth_revoked') await markReconnectRequired(env, conn.business_id, e.message, now);
    throw e;
  }
}

// ---------- job runner ----------

export type JobOutcome = 'synced' | 'retry' | 'failed' | 'paused' | 'skipped';

const backoffMs = (attempts: number) => Math.min(6 * 3600_000, 60_000 * 2 ** attempts);

export async function processJob(env: Env, jobId: string, now = Date.now()): Promise<JobOutcome> {
  const db = env.DB;
  const lease = await db.prepare(
    `UPDATE sync_jobs SET lease_until = ? WHERE id = ? AND status = 'pending' AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until < ?)`,
  ).bind(now + LEASE_MS, jobId, now, now).run();
  if (lease.meta.changes !== 1) return 'skipped';

  const job = (await db.prepare('SELECT * FROM sync_jobs WHERE id = ?').bind(jobId).first<JobRow>())!;
  const release = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).run();
  const quote = await db.prepare('SELECT * FROM quotes WHERE id = ? AND business_id = ?').bind(job.quote_id, job.business_id).first<QuoteRow>();
  const conn = await getConnection(env, job.business_id);
  if (!quote || !conn || conn.status !== 'connected') {
    await release("UPDATE sync_jobs SET status = 'paused', lease_until = NULL, updated_at = ? WHERE id = ?", now, job.id);
    return 'paused';
  }
  const version = job.version;
  try {
    const token = await getAccessToken(env, conn, now);
    if (job.kind === 'drive') {
      const file = await syncDrive(env, token, conn, job, quote);
      await db.batch([
        db.prepare(`UPDATE sync_jobs SET status = CASE WHEN version = ? THEN 'synced' ELSE 'pending' END, synced_version = ?, attempts = 0,
                    last_error = NULL, lease_until = NULL, drive_file_id = ?, drive_link = ?, synced_at = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
          .bind(version, version, file.id, file.webViewLink ?? null, now, now, now, job.id),
        markSheetDirtyStmt(env, job.business_id, job.quote_id, now), // add the photo link to the sheet row
        db.prepare('UPDATE google_connections SET last_sync_at = ?, last_error = NULL WHERE business_id = ?').bind(now, job.business_id),
      ]);
      const sheet = await db.prepare("SELECT id FROM sync_jobs WHERE business_id = ? AND quote_id = ? AND kind = 'sheet' AND status = 'pending'")
        .bind(job.business_id, job.quote_id).first<{ id: string }>();
      if (sheet) await dispatch(env, [sheet.id]);
    } else {
      const loc = await syncSheet(env, token, conn, job, quote, now);
      await db.batch([
        db.prepare(`UPDATE sync_jobs SET status = CASE WHEN version = ? THEN 'synced' ELSE 'pending' END, synced_version = ?, attempts = 0,
                    last_error = NULL, lease_until = NULL, spreadsheet_id = ?, sheet_id = ?, sheet_row = ?, synced_at = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
          .bind(version, version, loc.spreadsheetId, loc.sheetId, loc.row, now, now, now, job.id),
        db.prepare('UPDATE google_connections SET last_sync_at = ?, last_error = NULL WHERE business_id = ?').bind(now, job.business_id),
      ]);
    }
    return 'synced';
  } catch (e) {
    const err = e instanceof GoogleError ? e : new GoogleError('transient', 'Unexpected error while backing up.');
    if (err.kind === 'auth_revoked') {
      // markReconnectRequired already paused this business's jobs; make sure this one is paused too.
      await release("UPDATE sync_jobs SET status = 'paused', lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?", err.message, now, job.id);
      return 'paused';
    }
    if (err.message === 'SHEET_BUSY') {
      await release('UPDATE sync_jobs SET lease_until = NULL, next_attempt_at = ? WHERE id = ?', now + 30_000, job.id);
      return 'retry';
    }
    if (err.kind === 'unauthorized') {
      await db.prepare('UPDATE google_connections SET access_token_enc = NULL, access_expires_at = NULL WHERE business_id = ?').bind(job.business_id).run();
    }
    const attempts = job.attempts + 1;
    const permanent = err.kind === 'forbidden' || err.kind === 'not_found' || err.kind === 'bad_request' || err.kind === 'config';
    const failed = permanent || attempts >= MAX_ATTEMPTS;
    await release(`UPDATE sync_jobs SET status = ?, attempts = ?, last_error = ?, lease_until = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
      failed ? 'failed' : 'pending', attempts, err.message, now + backoffMs(attempts), now, job.id);
    if (permanent) await release('UPDATE google_connections SET last_error = ?, updated_at = ? WHERE business_id = ?', err.message, now, job.business_id);
    return failed ? 'failed' : 'retry';
  }
}

// ---------- Drive ----------

async function ensureFolder(env: Env, token: string, businessId: string, rootId: string, path: string[]): Promise<string> {
  let parent = rootId;
  for (let i = 0; i < path.length; i++) {
    const key = path.slice(0, i + 1).join('/');
    const cached = await env.DB.prepare('SELECT folder_id FROM drive_folders WHERE business_id = ? AND root_id = ? AND path = ?')
      .bind(businessId, rootId, key).first<{ folder_id: string }>();
    if (cached) { parent = cached.folder_id; continue; }
    const tag = `${rootId}/${key}`;
    const found = await driveFindByProperty(token, 'swarnaFolder', tag, parent);
    const folder = found ?? await driveCreateFolder(token, path[i], parent, { swarnaFolder: tag });
    await env.DB.prepare('INSERT OR REPLACE INTO drive_folders (business_id, root_id, path, folder_id) VALUES (?, ?, ?, ?)')
      .bind(businessId, rootId, key, folder.id).run();
    parent = folder.id;
  }
  return parent;
}

async function syncDrive(env: Env, token: string, conn: ConnectionRow, job: JobRow, q: QuoteRow) {
  // 1) Already uploaded on an earlier attempt? Keep using that file.
  if (job.drive_file_id) {
    try {
      const f = await driveGet(token, job.drive_file_id);
      if (!f.trashed) return f;
    } catch (e) {
      if (!(e instanceof GoogleError && e.kind === 'not_found')) throw e;
    }
  }
  // 2) Uploaded, but the result was not recorded (e.g. crash after upload)? Find it by its tag.
  const tagged = await driveFindByProperty(token, 'swarnaRecord', q.id);
  if (tagged) return tagged;
  // 3) Upload to the CURRENT destination (destination changes only affect future backups).
  if (!conn.drive_folder_id) throw new GoogleError('config', 'No Google Drive folder is selected.');
  const photo = await env.DB.prepare('SELECT r2_key, content_type FROM photos WHERE id = ? AND business_id = ?').bind(q.photo_id, q.business_id).first<{ r2_key: string; content_type: string }>();
  const obj = photo && await env.PHOTOS.get(photo.r2_key);
  if (!photo || !obj) throw new GoogleError('config', 'The photograph is missing from storage.');
  const { year, month } = istParts(q.created_at);
  let parent: string;
  try {
    parent = await ensureFolder(env, token, q.business_id, conn.drive_folder_id, [String(year), String(month).padStart(2, '0')]);
  } catch (e) {
    await env.DB.prepare('DELETE FROM drive_folders WHERE business_id = ? AND root_id = ?').bind(q.business_id, conn.drive_folder_id).run();
    throw e;
  }
  const ext = photo.content_type === 'image/png' ? 'png' : photo.content_type === 'image/webp' ? 'webp' : 'jpg';
  try {
    return await driveUpload(token, {
      name: `${q.order_no} - ${q.metal === 'gold' ? 'Gold' : 'Silver'} ${q.purity}.${ext}`,
      parents: [parent],
      appProperties: { swarnaRecord: q.id, swarnaBusiness: q.business_id },
      description: `Swarna Live buyback estimate ${q.order_no}. Photo of jewellery with scale reading; it does not verify weight or purity.`,
    }, await obj.arrayBuffer(), photo.content_type);
  } catch (e) {
    if (e instanceof GoogleError && e.kind === 'not_found') {
      // A cached month folder may have been deleted; forget the cache so the next attempt recreates it.
      await env.DB.prepare('DELETE FROM drive_folders WHERE business_id = ? AND root_id = ?').bind(q.business_id, conn.drive_folder_id).run();
      throw new GoogleError('transient', 'A Drive folder was missing and will be recreated.');
    }
    throw e;
  }
}

// ---------- Sheets ----------

export function sheetRow(q: QuoteRow, photoLink: string | null): (string | number)[] {
  return [
    q.order_no, formatIST(q.created_at), q.staff_name, q.customer_name, q.customer_phone, q.metal === 'gold' ? 'Gold' : 'Silver', q.item_type,
    q.description ?? '', q.purity, q.gross_mg / 1000, q.deduction_mg / 1000, q.net_mg / 1000, q.applied_rate_paise / 100,
    q.assessed_paise / 100, q.pct_bp / 100, q.offer_paise / 100, q.status[0].toUpperCase() + q.status.slice(1), q.notes ?? '', photoLink ?? '', q.id,
  ];
}

async function resolveSheetTitle(token: string, spreadsheetId: string, sheetId: number): Promise<string> {
  const ss = await sheetsGet(token, spreadsheetId);
  const tab = ss.sheets.find((s) => s.properties.sheetId === sheetId);
  if (!tab) throw new GoogleError('not_found', 'The Swarna Live worksheet was deleted. Choose or create the worksheet again in Settings → Backups & Integrations.');
  return tab.properties.title; // looked up by id each time, so a renamed tab still works
}

async function syncSheet(env: Env, token: string, conn: ConnectionRow, job: JobRow, q: QuoteRow, now: number) {
  // A row that already exists stays where it is; new rows go to the current destination.
  const spreadsheetId = job.spreadsheet_id ?? conn.spreadsheet_id;
  const sheetId = job.spreadsheet_id ? job.sheet_id : conn.sheet_id;
  if (!spreadsheetId || sheetId === null) throw new GoogleError('config', 'No Google Sheets worksheet is selected.');

  const lock = await env.DB.prepare('UPDATE google_connections SET sheet_lock_until = ? WHERE business_id = ? AND (sheet_lock_until IS NULL OR sheet_lock_until < ?)')
    .bind(now + SHEET_LOCK_MS, q.business_id, now).run();
  if (lock.meta.changes !== 1) throw new GoogleError('transient', 'SHEET_BUSY');
  try {
    const title = await resolveSheetTitle(token, spreadsheetId, sheetId);
    const header = await valuesGet(token, spreadsheetId, a1(title, `A1:${LAST_COL}1`));
    const h = header.values?.[0] ?? [];
    if (h.length === 0) await valuesUpdate(token, spreadsheetId, a1(title, `A1:${LAST_COL}1`), [SHEET_HEADERS]);
    else if (String(h[SHEET_HEADERS.length - 1] ?? '') !== SHEET_HEADERS[SHEET_HEADERS.length - 1]) {
      throw new GoogleError('forbidden', 'The worksheet header was changed, so Swarna Live will not write to it. Restore the header or choose a new worksheet.');
    }
    const drive = await env.DB.prepare("SELECT drive_link FROM sync_jobs WHERE business_id = ? AND quote_id = ? AND kind = 'drive' AND status = 'synced'")
      .bind(q.business_id, q.id).first<{ drive_link: string | null }>();
    const values = [sheetRow(q, drive?.drive_link ?? null)];

    // Find this record's row by its immutable id (never by order number or position alone).
    let row: number | null = null;
    if (job.sheet_row && job.spreadsheet_id === spreadsheetId) {
      const cell = await valuesGet(token, spreadsheetId, a1(title, `${ID_COL}${job.sheet_row}`));
      if (String(cell.values?.[0]?.[0] ?? '') === q.id) row = job.sheet_row;
    }
    if (row === null) {
      const col = await valuesGet(token, spreadsheetId, a1(title, `${ID_COL}:${ID_COL}`));
      const idx = (col.values ?? []).findIndex((r) => String(r[0] ?? '') === q.id);
      if (idx >= 0) row = idx + 1;
    }
    if (row !== null) {
      await valuesUpdate(token, spreadsheetId, a1(title, `A${row}:${LAST_COL}${row}`), values);
    } else {
      const res = await valuesAppend(token, spreadsheetId, a1(title, `A1:${LAST_COL}1`), values);
      const m = /!A(\d+)/.exec(res.updates?.updatedRange ?? '');
      row = m ? Number(m[1]) : null;
    }
    return { spreadsheetId, sheetId, row };
  } finally {
    await env.DB.prepare('UPDATE google_connections SET sheet_lock_until = NULL WHERE business_id = ?').bind(q.business_id).run();
  }
}
