// In-memory stand-in for Google's OAuth, Drive v3 and Sheets v4 endpoints,
// so the sync engine can be tested without real credentials.

interface FakeFile { id: string; name: string; mimeType: string; parents: string[]; appProperties: Record<string, string>; trashed: boolean; bytes?: number; createdByApp: boolean; permissions: string[] }

export class FakeGoogle {
  files = new Map<string, FakeFile>();
  sheets = new Map<string, { title: string; tabs: { sheetId: number; title: string; rows: (string | number)[][] }[] }>();
  revoked = false;
  refreshCount = 0;
  uploads = 0;
  failNext: { match: RegExp; status: number; times: number } | null = null;
  grantedScope = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';
  email = 'owner.backup@gmail.com';
  calls: string[] = [];
  private n = 0;

  constructor() {
    // A folder the user owns but the app did NOT create (invisible under drive.file).
    this.files.set('UserOwnedFolder123', { id: 'UserOwnedFolder123', name: 'My Jewellery', mimeType: 'application/vnd.google-apps.folder', parents: ['root'], appProperties: {}, trashed: false, createdByApp: false, permissions: [] });
    this.sheets.set('SpreadsheetAbcdefghijklmnop123', {
      title: 'Shop records', tabs: [
        { sheetId: 0, title: 'Sheet1', rows: [['Existing', 'data', 'keep me']] },
        { sheetId: 77, title: 'Empty tab', rows: [] },
      ],
    });
  }

  id(prefix: string) { return `${prefix}${++this.n}xxxxxxxxxxxxxxxx`; }
  tab(sheetId: number) { return this.sheets.get('SpreadsheetAbcdefghijklmnop123')!.tabs.find((t) => t.sheetId === sheetId)!; }

  private json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
  private err(status: number, message = 'error') { return this.json({ error: { code: status, message, status: 'ERR' } }, status); }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const method = req.method;
    this.calls.push(`${method} ${url.hostname}${url.pathname}`);
    if (this.failNext && this.failNext.match.test(`${method} ${url.hostname}${url.pathname}`) && this.failNext.times > 0) {
      this.failNext.times--;
      return this.err(this.failNext.status, 'injected failure');
    }

    // ---- OAuth ----
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const p = new URLSearchParams(await req.text());
      if (p.get('client_secret') !== 'test-client-secret') return this.json({ error: 'invalid_client' }, 401);
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'good-code' || !p.get('code_verifier')) return this.json({ error: 'invalid_grant' }, 400);
        const payload = btoa(JSON.stringify({ email: this.email })).replace(/=+$/, '');
        return this.json({ access_token: 'ya29.access-1', expires_in: 3599, refresh_token: '1//refresh-token-secret', scope: this.grantedScope, id_token: `x.${payload}.y` });
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (this.revoked) return this.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
        this.refreshCount++;
        return this.json({ access_token: `ya29.access-${this.refreshCount + 1}`, expires_in: 3599 });
      }
    }
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') { this.revoked = true; return this.json({}); }

    const auth = req.headers.get('authorization') || '';
    if (!auth.startsWith('Bearer ya29.')) return this.err(401);
    if (this.revoked) return this.err(401);

    // ---- Drive ----
    if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/drive/v3/files')) {
      const id = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      if (method === 'GET' && id) {
        const f = this.files.get(id);
        if (!f || !f.createdByApp) return this.err(404, 'File not found'); // drive.file: only the app's own files
        return this.json({ id: f.id, name: f.name, mimeType: f.mimeType, trashed: f.trashed, webViewLink: `https://drive.google.com/file/d/${f.id}/view`, capabilities: { canAddChildren: true, canEdit: true } });
      }
      if (method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const m = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/.exec(q);
        const parent = /'([^']+)' in parents/.exec(q)?.[1];
        const files = [...this.files.values()].filter((f) => f.createdByApp && !f.trashed && m && f.appProperties[m[1]] === m[2] && (!parent || f.parents.includes(parent)));
        return this.json({ files: files.map((f) => ({ id: f.id, name: f.name, webViewLink: `https://drive.google.com/file/d/${f.id}/view` })) });
      }
      if (method === 'POST') {
        const body = await req.json<{ name: string; mimeType: string; parents?: string[]; appProperties: Record<string, string> }>();
        const f: FakeFile = { id: this.id('Folder'), name: body.name, mimeType: body.mimeType, parents: body.parents ?? ['root'], appProperties: body.appProperties ?? {}, trashed: false, createdByApp: true, permissions: [] };
        this.files.set(f.id, f);
        return this.json({ id: f.id, name: f.name, webViewLink: `https://drive.google.com/drive/folders/${f.id}` });
      }
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const raw = new Uint8Array(await req.arrayBuffer());
      const text = new TextDecoder('latin1').decode(raw);
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(text)![1]);
      const parent = meta.parents[0];
      if (!this.files.get(parent)?.createdByApp) return this.err(404, 'parent not found');
      this.uploads++;
      const f: FakeFile = { id: this.id('Photo'), name: meta.name, mimeType: meta.mimeType, parents: meta.parents, appProperties: meta.appProperties, trashed: false, bytes: raw.length, createdByApp: true, permissions: [] };
      this.files.set(f.id, f);
      return this.json({ id: f.id, name: f.name, webViewLink: `https://drive.google.com/file/d/${f.id}/view` });
    }

    // ---- Sheets ----
    if (url.hostname === 'sheets.googleapis.com') {
      const parts = url.pathname.split('/'); // /v4/spreadsheets/{id}[/values/{range}[:append]] or {id}:batchUpdate
      const [ssId, op] = decodeURIComponent(parts[3]).split(':');
      const ss = this.sheets.get(ssId);
      if (!ss) return this.err(404, 'Requested entity was not found.');
      if (op === 'batchUpdate') {
        const body = await req.json<{ requests: { addSheet: { properties: { title: string } } }[] }>();
        const t = { sheetId: 1000 + ss.tabs.length, title: body.requests[0].addSheet.properties.title, rows: [] };
        ss.tabs.push(t);
        return this.json({ replies: [{ addSheet: { properties: { sheetId: t.sheetId, title: t.title } } }] });
      }
      if (parts[4] !== 'values') return this.json({ spreadsheetId: ssId, properties: { title: ss.title }, sheets: ss.tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title } })) });
      const [rangeRaw, action] = decodeURIComponent(parts.slice(5).join('/')).split(':append');
      const m = /^'((?:[^']|'')+)'!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(rangeRaw)!;
      const tab = ss.tabs.find((t) => t.title === m[1].replace(/''/g, "'"));
      if (!tab) return this.err(400, 'Unable to parse range');
      const col = (c: string) => c.charCodeAt(0) - 65;
      const r1 = m[3] ? Number(m[3]) : 1;
      const r2 = m[5] !== undefined ? (m[5] ? Number(m[5]) : tab.rows.length) : (m[3] ? r1 : tab.rows.length);
      const c1 = col(m[2]);
      const c2 = m[4] ? col(m[4]) : c1;
      if (method === 'GET') {
        const values = tab.rows.slice(r1 - 1, r2).map((r) => r.slice(c1, c2 + 1));
        while (values.length && values[values.length - 1].every((v) => v === '' || v === undefined)) values.pop();
        return this.json(values.length ? { values } : {});
      }
      if (url.searchParams.get('valueInputOption') !== 'RAW') return this.err(400, 'expected RAW');
      const body = await req.json<{ values: (string | number)[][] }>();
      if (action !== undefined) {
        const row = tab.rows.length + 1;
        tab.rows.push(body.values[0]);
        return this.json({ updates: { updatedRange: `'${tab.title}'!A${row}:T${row}` } });
      }
      body.values.forEach((v, i) => {
        while (tab.rows.length < r1 + i) tab.rows.push([]);
        const row = tab.rows[r1 - 1 + i];
        v.forEach((cell, j) => { row[c1 + j] = cell; });
      });
      return this.json({ updatedRange: rangeRaw });
    }
    return this.err(404, `fake: unhandled ${method} ${url.href}`);
  };
}
