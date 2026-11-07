import type { Ctx } from '../context';
import { auditStmt, checkCsrf, loadSession, requireOwner, requireRecentOwnerAuth } from '../context';
import { b64url, encryptString, randomToken, sha256 } from '../crypto';
import { HttpError, bad, json, str } from '../http';
import type { Router } from '../router';
import {
  GoogleError, SCOPE_DRIVE_FILE, SCOPE_SHEETS, FOLDER_MIME, a1, addSheet, buildAuthUrl, driveCreateFolder, driveGet, emailFromIdToken,
  exchangeCode, folderLink, googleConfigured, parseDriveFolderId, parseSpreadsheetUrl, redirectUri, revokeToken, sheetLink, sheetsGet, valuesGet, valuesUpdate,
} from '../google/client';
import { LAST_COL, SHEET_HEADERS, dispatch, getAccessToken, getConnection, runDueJobs, type ConnectionRow } from '../google/sync';
import { decryptString } from '../crypto';

const DEFAULT_TAB = 'Swarna Live Transactions';

function friendly(e: unknown): HttpError {
  if (e instanceof GoogleError) {
    if (e.kind === 'auth_revoked') return new HttpError(409, 'Google access was revoked or expired. Please reconnect your Google account.', 'GOOGLE_RECONNECT');
    if (e.kind === 'transient') return new HttpError(503, 'Google is not reachable right now. Please try again in a few minutes.', 'GOOGLE_UNAVAILABLE');
    return new HttpError(422, e.message, 'GOOGLE_DESTINATION');
  }
  return e instanceof HttpError ? e : new HttpError(500, 'Something went wrong talking to Google.', 'GOOGLE_ERROR');
}

async function connected(ctx: Ctx): Promise<{ conn: ConnectionRow; token: string }> {
  const conn = await getConnection(ctx.env, ctx.session!.business_id);
  if (!conn || conn.status !== 'connected') throw new HttpError(409, 'Connect a Google account first.', 'GOOGLE_NOT_CONNECTED');
  try {
    return { conn, token: await getAccessToken(ctx.env, conn, ctx.now) };
  } catch (e) {
    throw friendly(e);
  }
}

type TabState = 'empty' | 'swarna' | 'other';
async function tabState(token: string, spreadsheetId: string, title: string): Promise<TabState> {
  const v = await valuesGet(token, spreadsheetId, a1(title, `A1:${LAST_COL}3`));
  const rows = v.values ?? [];
  if (rows.length === 0 || rows.every((r) => r.every((c) => c === '' || c === null))) return 'empty';
  return String(rows[0]?.[SHEET_HEADERS.length - 1] ?? '') === SHEET_HEADERS[SHEET_HEADERS.length - 1] ? 'swarna' : 'other';
}

async function checkFolder(token: string, id: string) {
  const f = await driveGet(token, id);
  if (f.mimeType !== FOLDER_MIME || f.trashed) throw new GoogleError('bad_request', 'That link is not an active Google Drive folder.');
  if (!f.capabilities?.canAddChildren) throw new GoogleError('forbidden', 'The connected Google account cannot add files to that folder.');
  return f;
}

function folderError(e: unknown): HttpError {
  if (e instanceof GoogleError && (e.kind === 'not_found' || e.kind === 'forbidden')) {
    return new HttpError(422, 'Swarna Live cannot use that folder. With the limited Drive permission Swarna Live asks for, it can only use folders it created. Use “Create a backup folder for me”, then move that folder wherever you like in your Drive.', 'GOOGLE_FOLDER_ACCESS');
  }
  return friendly(e);
}

export function googleRoutes(r: Router) {
  r.get('/google/status', async (ctx) => {
    await requireOwner(ctx);
    const businessId = ctx.session!.business_id;
    const conn = await getConnection(ctx.env, businessId);
    const db = ctx.env.DB;
    const [counts, missing] = await db.batch([
      db.prepare('SELECT kind, status, COUNT(*) AS n FROM sync_jobs WHERE business_id = ? GROUP BY kind, status').bind(businessId),
      db.prepare('SELECT COUNT(*) AS n FROM quotes q WHERE q.business_id = ? AND NOT EXISTS (SELECT 1 FROM sync_jobs j WHERE j.quote_id = q.id)').bind(businessId),
    ]);
    const c: Record<string, Record<string, number>> = { drive: {}, sheet: {} };
    for (const row of counts.results as { kind: string; status: string; n: number }[]) c[row.kind][row.status] = row.n;
    return json({
      configured: googleConfigured(ctx.env),
      redirect_uri: redirectUri(ctx.env),
      connection: conn && {
        status: conn.status, google_email: conn.google_email, connected_at: conn.connected_at, last_sync_at: conn.last_sync_at, last_error: conn.last_error,
        folder: conn.drive_folder_id ? { id: conn.drive_folder_id, name: conn.drive_folder_name, link: folderLink(conn.drive_folder_id) } : null,
        sheet: conn.spreadsheet_id ? { spreadsheet_id: conn.spreadsheet_id, title: conn.spreadsheet_title, sheet_id: conn.sheet_id, sheet_title: conn.sheet_title, link: sheetLink(conn.spreadsheet_id, conn.sheet_id) } : null,
      },
      counts: c,
      not_backed_up: (missing.results[0] as { n: number }).n,
    });
  });

  r.post('/google/connect', async (ctx) => {
    const st = await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    if (!googleConfigured(ctx.env)) throw new HttpError(503, 'Google connection has not been set up for this website yet. See docs/GOOGLE_SETUP.md.', 'GOOGLE_NOT_CONFIGURED');
    const state = randomToken(32);
    const verifier = randomToken(48);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const db = ctx.env.DB;
    await db.batch([
      db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(ctx.now),
      db.prepare('INSERT INTO oauth_states (state_hash, business_id, session_hash, staff_id, code_verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(await sha256(state), ctx.session!.business_id, ctx.session!.id_hash, st.id, verifier, ctx.now + 10 * 60_000),
    ]);
    return json({ auth_url: buildAuthUrl(ctx.env, state, challenge) });
  });

  /** Google redirects the owner's browser here. Responds with a redirect back into the app, never with tokens. */
  r.get('/google/callback', async (ctx) => {
    const back = (result: string) => new Response(null, { status: 302, headers: { Location: `/settings/backups?google=${result}`, 'Cache-Control': 'no-store' } });
    const p = ctx.url.searchParams;
    const state = p.get('state') || '';
    if (!state || state.length > 200) return back('invalid_state');
    const db = ctx.env.DB;
    const row = await db.prepare('SELECT * FROM oauth_states WHERE state_hash = ?').bind(await sha256(state)).first<{
      business_id: string; session_hash: string; staff_id: string; code_verifier: string; expires_at: number; state_hash: string }>();
    if (!row) return back('invalid_state');
    await db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(row.state_hash).run(); // single use
    if (row.expires_at < ctx.now) return back('expired');
    // The browser finishing the flow must be the same signed-in owner session that started it.
    const s = await loadSession(ctx);
    if (!s || s.id_hash !== row.session_hash || s.business_id !== row.business_id || s.staff_id !== row.staff_id || s.owner_staff_id !== row.staff_id) {
      return back('session_mismatch');
    }
    if (p.get('error')) return back('denied');
    const code = p.get('code');
    if (!code) return back('invalid_state');
    let tokens;
    try {
      tokens = await exchangeCode(ctx.env, code, row.code_verifier);
    } catch {
      return back('exchange_failed');
    }
    const granted = (tokens.scope || '').split(/\s+/);
    if (!granted.includes(SCOPE_DRIVE_FILE) || !granted.includes(SCOPE_SHEETS)) {
      await revokeToken(tokens.refresh_token ?? tokens.access_token);
      return back('missing_permissions');
    }
    if (!tokens.refresh_token) {
      await revokeToken(tokens.access_token);
      return back('no_offline_access');
    }
    const googleEmail = emailFromIdToken(tokens.id_token);
    const prev = await getConnection(ctx.env, row.business_id);
    const sameAccount = !!prev?.google_email && prev.google_email === googleEmail;
    const refreshEnc = await encryptString(tokens.refresh_token, ctx.env.TOKEN_ENCRYPTION_KEY, `refresh:${row.business_id}`);
    const accessEnc = await encryptString(tokens.access_token, ctx.env.TOKEN_ENCRYPTION_KEY, `access:${row.business_id}`);
    // Revoke the previous grant if a different token is being replaced.
    if (prev?.refresh_token_enc) {
      const old = await decryptString(prev.refresh_token_enc, ctx.env.TOKEN_ENCRYPTION_KEY, `refresh:${row.business_id}`).catch(() => null);
      if (old && old !== tokens.refresh_token) ctx.exec.waitUntil(revokeToken(old));
    }
    const owner = { id: row.staff_id, name: 'Owner' };
    await db.batch([
      db.prepare(`INSERT INTO google_connections (business_id, status, google_email, scopes, refresh_token_enc, access_token_enc, access_expires_at,
                    connected_at, connected_by, last_error, updated_at)
                  VALUES (?, 'connected', ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                  ON CONFLICT (business_id) DO UPDATE SET status = 'connected', google_email = excluded.google_email, scopes = excluded.scopes,
                    refresh_token_enc = excluded.refresh_token_enc, access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at,
                    connected_at = excluded.connected_at, connected_by = excluded.connected_by, last_error = NULL, updated_at = excluded.updated_at`)
        .bind(row.business_id, googleEmail, granted.join(' '), refreshEnc, accessEnc, ctx.now + tokens.expires_in * 1000, ctx.now, row.staff_id, ctx.now),
      // A different Google account cannot use the old account's folder/sheet: clear them so the owner chooses again.
      ...(sameAccount ? [] : [db.prepare(`UPDATE google_connections SET drive_folder_id = NULL, drive_folder_name = NULL, spreadsheet_id = NULL,
                    spreadsheet_title = NULL, sheet_id = NULL, sheet_title = NULL, destinations_at = NULL WHERE business_id = ?`).bind(row.business_id)]),
      auditStmt(ctx, { businessId: row.business_id, action: 'google.connected', staff: owner, after: { google_email: googleEmail } }),
    ]);
    return back('connected');
  });

  r.post('/google/test', async (ctx) => {
    await requireOwner(ctx);
    checkCsrf(ctx);
    const checks: { name: string; ok: boolean; message: string }[] = [];
    let conn: ConnectionRow, token: string;
    try {
      ({ conn, token } = await connected(ctx));
      checks.push({ name: 'Google account', ok: true, message: `Connected as ${conn.google_email ?? 'Google account'}` });
    } catch (e) {
      const err = friendly(e);
      return json({ ok: false, checks: [{ name: 'Google account', ok: false, message: err.message }] });
    }
    if (conn.drive_folder_id) {
      try { const f = await checkFolder(token, conn.drive_folder_id); checks.push({ name: 'Drive folder', ok: true, message: `Can add files to “${f.name}”` }); }
      catch (e) { checks.push({ name: 'Drive folder', ok: false, message: folderError(e).message }); }
    } else checks.push({ name: 'Drive folder', ok: false, message: 'No folder selected yet.' });
    if (conn.spreadsheet_id && conn.sheet_id !== null) {
      try {
        const ss = await sheetsGet(token, conn.spreadsheet_id);
        const tab = ss.sheets.find((x) => x.properties.sheetId === conn.sheet_id);
        if (!tab) throw new GoogleError('not_found', 'The Swarna Live worksheet no longer exists in that spreadsheet.');
        const stt = await tabState(token, conn.spreadsheet_id, tab.properties.title);
        if (stt === 'other') throw new GoogleError('forbidden', 'The worksheet header was changed. Restore it or choose a new worksheet.');
        // A harmless write of the header proves write access.
        await valuesUpdate(token, conn.spreadsheet_id, a1(tab.properties.title, `A1:${LAST_COL}1`), [SHEET_HEADERS]);
        checks.push({ name: 'Spreadsheet', ok: true, message: `Can write to “${ss.properties.title}” → “${tab.properties.title}”` });
      } catch (e) { checks.push({ name: 'Spreadsheet', ok: false, message: friendly(e).message }); }
    } else checks.push({ name: 'Spreadsheet', ok: false, message: 'No spreadsheet selected yet.' });
    return json({ ok: checks.every((c) => c.ok), checks });
  });

  /** Creates a new private folder in the owner's My Drive that Swarna Live can use. */
  r.post('/google/folder', async (ctx) => {
    await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    const { token } = await connected(ctx);
    const b = await ctx.env.DB.prepare('SELECT name FROM businesses WHERE id = ?').bind(ctx.session!.business_id).first<{ name: string }>();
    try {
      const f = await driveCreateFolder(token, `Swarna Live Backups - ${b?.name ?? 'Business'}`.slice(0, 120), null, { swarnaRoot: ctx.session!.business_id });
      return json({ id: f.id, name: f.name, link: folderLink(f.id) });
    } catch (e) { throw friendly(e); }
  });

  /** Checks links without saving: folder access and the spreadsheet's worksheets. */
  r.post('/google/inspect', async (ctx) => {
    await requireOwner(ctx);
    checkCsrf(ctx);
    const { token } = await connected(ctx);
    const out: Record<string, unknown> = {};
    const folderInput = str(ctx.body.folder, 'Drive folder link', { max: 500 });
    if (folderInput) {
      const id = parseDriveFolderId(folderInput);
      if (!id) throw bad('That is not a Google Drive folder link. It should look like https://drive.google.com/drive/folders/…');
      try { const f = await checkFolder(token, id); out.folder = { id, name: f.name, link: folderLink(id) }; }
      catch (e) { throw folderError(e); }
    }
    const sheetInput = str(ctx.body.spreadsheet, 'Spreadsheet link', { max: 500 });
    if (sheetInput) {
      const parsed = parseSpreadsheetUrl(sheetInput);
      if (!parsed) throw bad('That is not a Google Sheets link. It should look like https://docs.google.com/spreadsheets/d/…');
      try {
        const ss = await sheetsGet(token, parsed.id);
        const tabs = [];
        for (const t of ss.sheets.slice(0, 30)) {
          tabs.push({ sheet_id: t.properties.sheetId, title: t.properties.title, state: await tabState(token, parsed.id, t.properties.title) });
        }
        out.spreadsheet = { id: parsed.id, title: ss.properties.title, link: sheetLink(parsed.id), tabs, suggested_sheet_id: parsed.gid };
      } catch (e) { throw friendly(e); }
    }
    return json(out);
  });

  r.post('/google/destinations', async (ctx) => {
    await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    const { conn, token } = await connected(ctx);
    const businessId = ctx.session!.business_id;
    const folderId = parseDriveFolderId(str(ctx.body.folder, 'Drive folder link', { required: true, max: 500 })!);
    if (!folderId) throw bad('That is not a Google Drive folder link.');
    const parsed = parseSpreadsheetUrl(str(ctx.body.spreadsheet, 'Spreadsheet link', { required: true, max: 500 })!);
    if (!parsed) throw bad('That is not a Google Sheets link.');
    const sheetChoice = ctx.body.sheet as { sheet_id?: unknown; new_title?: unknown } | undefined;
    if (!sheetChoice || typeof sheetChoice !== 'object') throw bad('Choose a worksheet.');

    let folderName: string;
    try { folderName = (await checkFolder(token, folderId)).name ?? 'Drive folder'; } catch (e) { throw folderError(e); }

    let sheet: { sheetId: number; title: string };
    let spreadsheetTitle: string;
    try {
      const ss = await sheetsGet(token, parsed.id);
      spreadsheetTitle = ss.properties.title;
      if (sheetChoice.new_title !== undefined) {
        const title = str(sheetChoice.new_title, 'Worksheet name', { required: true, max: 90 }) ?? DEFAULT_TAB;
        if (/[[\]*?/\\:]/.test(title)) throw bad('Worksheet names cannot contain [ ] * ? / \\ :');
        if (ss.sheets.some((x) => x.properties.title.toLowerCase() === title.toLowerCase())) throw bad('A worksheet with that name already exists. Choose it from the list instead.');
        if (ctx.body.confirm_initialize !== true) throw new HttpError(409, `Swarna Live will add a new worksheet “${title}” and manage it. Please confirm.`, 'CONFIRM_REQUIRED');
        const added = await addSheet(token, parsed.id, title);
        sheet = { sheetId: added.sheetId, title: added.title };
        await valuesUpdate(token, parsed.id, a1(sheet.title, `A1:${LAST_COL}1`), [SHEET_HEADERS]);
      } else {
        const id = Number(sheetChoice.sheet_id);
        const tab = ss.sheets.find((x) => x.properties.sheetId === id);
        if (!tab) throw bad('That worksheet does not exist in the spreadsheet.');
        sheet = { sheetId: id, title: tab.properties.title };
        const stt = await tabState(token, parsed.id, sheet.title);
        if (stt === 'other') throw bad('That worksheet already has other content. Swarna Live only writes to an empty worksheet or one it set up. Choose another, or let Swarna Live create a new worksheet.');
        if (stt === 'empty' && ctx.body.confirm_initialize !== true) {
          throw new HttpError(409, `Swarna Live will write its column headings into “${sheet.title}” and manage that worksheet. Please confirm.`, 'CONFIRM_REQUIRED');
        }
        // Writing the header row also proves the account can edit this spreadsheet.
        await valuesUpdate(token, parsed.id, a1(sheet.title, `A1:${LAST_COL}1`), [SHEET_HEADERS]);
      }
    } catch (e) { throw friendly(e); }

    const before = { folder: conn.drive_folder_id, spreadsheet: conn.spreadsheet_id, sheet_id: conn.sheet_id };
    const after = { folder: folderId, spreadsheet: parsed.id, sheet_id: sheet.sheetId };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`UPDATE google_connections SET drive_folder_id = ?, drive_folder_name = ?, spreadsheet_id = ?, spreadsheet_title = ?, sheet_id = ?,
                          sheet_title = ?, destinations_at = ?, last_error = NULL, updated_at = ? WHERE business_id = ?`)
        .bind(folderId, folderName, parsed.id, spreadsheetTitle, sheet.sheetId, sheet.title, ctx.now, ctx.now, businessId),
      auditStmt(ctx, { businessId, action: 'google.destinations_changed', before, after }),
    ]);
    return json({ ok: true });
  });

  r.post('/google/retry', async (ctx) => {
    await requireOwner(ctx);
    checkCsrf(ctx);
    const businessId = ctx.session!.business_id;
    const quoteId = typeof ctx.body.quote_id === 'string' ? ctx.body.quote_id : null;
    const res = await ctx.env.DB.prepare(
      `UPDATE sync_jobs SET status = 'pending', attempts = 0, next_attempt_at = ?, lease_until = NULL, updated_at = ?
       WHERE business_id = ? AND status = 'failed' AND (?4 IS NULL OR quote_id = ?4)`,
    ).bind(ctx.now, ctx.now, businessId, quoteId).run();
    const ids = await ctx.env.DB.prepare("SELECT id FROM sync_jobs WHERE business_id = ? AND status = 'pending' AND (?2 IS NULL OR quote_id = ?2) ORDER BY kind LIMIT 25")
      .bind(businessId, quoteId).all<{ id: string }>();
    ctx.exec.waitUntil(dispatch(ctx.env, ids.results.map((x) => x.id)).catch(() => undefined));
    return json({ retried: res.meta.changes });
  });

  /** After reconnecting: back up records saved while disconnected (and resume paused ones). Owner-controlled. */
  r.post('/google/backfill', async (ctx) => {
    await requireOwner(ctx);
    checkCsrf(ctx);
    const { conn } = await connected(ctx);
    if (!conn.drive_folder_id || !conn.spreadsheet_id || conn.sheet_id === null) throw new HttpError(409, 'Choose a Drive folder and worksheet first.', 'GOOGLE_NO_DESTINATION');
    const businessId = ctx.session!.business_id;
    const db = ctx.env.DB;
    const ins = (kind: string) => db.prepare(
      `INSERT INTO sync_jobs (id, business_id, quote_id, kind, status, next_attempt_at, created_at, updated_at)
       SELECT lower(hex(randomblob(16))), q.business_id, q.id, ?, 'pending', ?, ?, ? FROM quotes q
       WHERE q.business_id = ? AND NOT EXISTS (SELECT 1 FROM sync_jobs j WHERE j.quote_id = q.id AND j.kind = ?)`,
    ).bind(kind, ctx.now, ctx.now, ctx.now, businessId, kind);
    const [resumed, d, s] = await db.batch([
      db.prepare(`UPDATE sync_jobs SET status = 'pending', attempts = 0, next_attempt_at = ?, lease_until = NULL, updated_at = ?
                  WHERE business_id = ? AND status = 'paused'`).bind(ctx.now, ctx.now, businessId),
      ins('drive'), ins('sheet'),
      auditStmt(ctx, { businessId, action: 'google.backfill_started' }),
    ]);
    ctx.exec.waitUntil(runDueJobs(ctx.env, ctx.now, 25).catch(() => 0));
    return json({ resumed: resumed.meta.changes, queued: d.meta.changes + s.meta.changes });
  });

  /** Stops backups, revokes Swarna Live's Google access. Files already in Drive/Sheets are left untouched. */
  r.post('/google/disconnect', async (ctx) => {
    await requireRecentOwnerAuth(ctx);
    checkCsrf(ctx);
    const businessId = ctx.session!.business_id;
    const conn = await getConnection(ctx.env, businessId);
    if (!conn) return json({ ok: true });
    if (conn.refresh_token_enc) {
      const t = await decryptString(conn.refresh_token_enc, ctx.env.TOKEN_ENCRYPTION_KEY, `refresh:${businessId}`).catch(() => null);
      if (t) await revokeToken(t);
    }
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`UPDATE google_connections SET status = 'disconnected', refresh_token_enc = NULL, access_token_enc = NULL, access_expires_at = NULL,
                          updated_at = ? WHERE business_id = ?`).bind(ctx.now, businessId),
      ctx.env.DB.prepare("UPDATE sync_jobs SET status = 'paused', lease_until = NULL, updated_at = ? WHERE business_id = ? AND status IN ('pending','failed')").bind(ctx.now, businessId),
      auditStmt(ctx, { businessId, action: 'google.disconnected', before: { google_email: conn.google_email } }),
    ]);
    return json({ ok: true });
  });
}
