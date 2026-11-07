// Swarna Live API. Platform-neutral: it takes a Fetch API Request and returns
// a Response, so the same code runs on Cloudflare Workers (D1 + R2) and on
// Node.js (node:sqlite + local folder) for development and tests.
//
//   db:    { all(sql, ...p), get(sql, ...p), run(sql, ...p) -> { changes, lastId } }
//   files: { put(key, data, contentType), get(key) -> { body, contentType } | null, delete(key) }

import { computeLoan, todayIso } from './loanmath.js';

const SESSION_DAYS = 7;
const COOKIE = 'sl_session';
const PBKDF2_ITERATIONS = 100000; // Cloudflare Workers' maximum
const MAX_UPLOAD = 10 * 1024 * 1024;
const UPLOAD_TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf',
};

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hex(salt)}$${hex(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}
async function verifyPassword(password, stored) {
  const [kind, iter, salt, expected] = String(stored).split('$');
  if (kind !== 'pbkdf2' || !salt || !expected) return false;
  const actual = hex(await pbkdf2(password, unhex(salt), Number(iter)));
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const str = (v, max = 500) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > max) throw bad(`Value too long (max ${max} characters)`);
  return s;
};
const isoDate = (v, label, required = false) => {
  const s = str(v, 10);
  if (!s) { if (required) throw bad(`${label} is required`); return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad(`${label} must be a valid date`);
  return s;
};
const num = (v, label, { required = false, min = 0, max = 1e12 } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${label} is required`); return null; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} must be a number between ${min} and ${max}`);
  return n;
};
const phone = (v, label, required) => {
  const s = str(v, 20);
  if (!s) { if (required) throw bad(`${label} is required`); return null; }
  if (!/^\+?[0-9][0-9 -]{6,18}$/.test(s)) throw bad(`${label} looks invalid`);
  return s;
};
const intId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Not found');
  return n;
};

export function maskId(idNumber) {
  if (!idNumber) return null;
  const s = String(idNumber);
  return s.length <= 4 ? s : '•'.repeat(Math.min(8, s.length - 4)) + s.slice(-4);
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

// ---------- app ----------

/**
 * @param {object} opts
 * @param {object} opts.db       database adapter
 * @param {object} opts.files    file storage adapter
 * @param {boolean} opts.secureCookies   add `Secure` to the session cookie (HTTPS)
 * @param {string|null} opts.setupCode   if set, creating the first account needs this code
 */
export function createApp({ db, files, secureCookies = false, setupCode = null }) {
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    routes.push({ method, re, handler, auth });
  };

  // --- sessions ---
  const userCount = async () => (await db.get('SELECT COUNT(*) AS n FROM users')).n;

  async function sessionCookie(userId) {
    const token = randomHex(32);
    const now = Date.now();
    await db.run('DELETE FROM sessions WHERE expires_at < ?', now);
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', await sha256(token), userId, now + SESSION_DAYS * 86400000);
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secureCookies ? '; Secure' : ''}`;
  }

  async function currentUser(req) {
    const token = parseCookies(req.headers.get('cookie'))[COOKIE];
    if (!token) return null;
    return db.get(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash = ? AND s.expires_at > ?`, await sha256(token), Date.now());
  }

  async function readJson(req) {
    if (Number(req.headers.get('content-length') || 0) > 1024 * 1024) throw new HttpError(413, 'Request too large');
    const text = await req.text();
    if (!text.trim()) return {};
    try { return JSON.parse(text) || {}; } catch { throw bad('Invalid request'); }
  }

  // --- auth routes ---
  route('GET', '/status', async ({ req }) => json({
    setupNeeded: (await userCount()) === 0, setupCodeRequired: !!setupCode, user: await currentUser(req),
  }), { auth: false });

  route('POST', '/setup', async ({ req, body }) => {
    if ((await userCount()) > 0) throw new HttpError(403, 'Setup already completed');
    if (setupCode && String(body.setup_code || '').trim() !== setupCode) throw new HttpError(403, 'Wrong setup code');
    const username = str(body.username, 50);
    const password = String(body.password || '');
    if (!username) throw bad('Username is required');
    if (password.length < 8) throw bad('Password must be at least 8 characters');
    const { lastId } = await db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', username, await hashPassword(password));
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(lastId) });
  }, { auth: false });

  route('POST', '/login', async ({ body, ip }) => {
    const since = Date.now() - 15 * 60000;
    await db.run('DELETE FROM login_failures WHERE at < ?', since);
    const { n } = await db.get('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at >= ?', ip, since);
    if (n >= 10) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const user = await db.get('SELECT * FROM users WHERE username = ?', String(body.username || '').trim());
    if (!user || !(await verifyPassword(String(body.password || ''), user.password_hash))) {
      await db.run('INSERT INTO login_failures (ip, at) VALUES (?, ?)', ip, Date.now());
      throw new HttpError(401, 'Wrong username or password');
    }
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(user.id) });
  }, { auth: false });

  route('POST', '/logout', async ({ req }) => {
    const token = parseCookies(req.headers.get('cookie'))[COOKIE];
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', await sha256(token));
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }, { auth: false });

  route('POST', '/password', async ({ user, body }) => {
    const row = await db.get('SELECT * FROM users WHERE id = ?', user.id);
    if (!(await verifyPassword(String(body.current || ''), row.password_hash))) throw bad('Current password is wrong');
    const next = String(body.password || '');
    if (next.length < 8) throw bad('New password must be at least 8 characters');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(next), user.id);
    return json({ ok: true });
  });

  route('GET', '/users', async () => json(await db.all('SELECT id, username, created_at FROM users ORDER BY id')));

  route('POST', '/users', async ({ body }) => {
    const username = str(body.username, 50);
    const password = String(body.password || '');
    if (!username) throw bad('Username is required');
    if (password.length < 8) throw bad('Password must be at least 8 characters');
    if (await db.get('SELECT 1 AS x FROM users WHERE username = ?', username)) throw bad('That username is taken');
    await db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', username, await hashPassword(password));
    return json({ ok: true });
  });

  // --- loan balance helpers ---
  async function withBalances(loans) {
    if (!loans.length) return [];
    const pays = await db.all('SELECT * FROM payments WHERE loan_id IN (SELECT value FROM json_each(?)) ORDER BY paid_on, id',
      JSON.stringify(loans.map((l) => l.id)));
    const byLoan = new Map();
    for (const p of pays) (byLoan.get(p.loan_id) || byLoan.set(p.loan_id, []).get(p.loan_id)).push(p);
    return loans.map((l) => ({ ...l, ...computeLoan(l, byLoan.get(l.id) || []) }));
  }

  const documentsFor = (type, id) => db.all(
    'SELECT id, label, filename, content_type, size, created_at FROM documents WHERE owner_type = ? AND owner_id = ? ORDER BY id', type, id);

  async function deleteDocuments(type, id) {
    const docs = await db.all('SELECT id, storage_key FROM documents WHERE owner_type = ? AND owner_id = ?', type, id);
    for (const d of docs) await files.delete(d.storage_key);
    await db.run('DELETE FROM documents WHERE owner_type = ? AND owner_id = ?', type, id);
  }

  // --- customers ---
  const CUSTOMER_COLS = ['name', 'guardian_name', 'phone', 'alt_phone', 'email', 'dob', 'address', 'id_type', 'id_number', 'id_type_2', 'id_number_2', 'notes'];
  function readCustomer(b) {
    const name = str(b.name, 120);
    if (!name) throw bad('Customer name is required');
    return {
      name,
      guardian_name: str(b.guardian_name, 120),
      phone: phone(b.phone, 'Phone number', true),
      alt_phone: phone(b.alt_phone, 'Alternate phone', false),
      email: str(b.email, 120),
      dob: isoDate(b.dob, 'Date of birth'),
      address: str(b.address, 500),
      id_type: str(b.id_type, 40),
      id_number: str(b.id_number, 40),
      id_type_2: str(b.id_type_2, 40),
      id_number_2: str(b.id_number_2, 40),
      notes: str(b.notes, 2000),
    };
  }

  route('GET', '/customers', async ({ url }) => {
    const q = str(url.searchParams.get('q'), 100);
    const like = `%${q || ''}%`;
    const rows = await db.all(`
      SELECT c.id, c.name, c.phone, c.id_type, c.id_number, c.created_at,
             (SELECT COUNT(*) FROM loans l WHERE l.customer_id = c.id AND l.status = 'active') AS active_loans,
             (SELECT COUNT(*) FROM loans l WHERE l.customer_id = c.id) AS total_loans
      FROM customers c
      WHERE ? IS NULL OR c.name LIKE ? OR c.phone LIKE ? OR c.alt_phone LIKE ? OR c.id_number LIKE ? OR c.id_number_2 LIKE ?
      ORDER BY c.name COLLATE NOCASE`, q, like, like, like, like, like);
    return json(rows.map(({ id_number, ...r }) => ({ ...r, id_number_masked: maskId(id_number) })));
  });

  route('POST', '/customers', async ({ body }) => {
    const c = readCustomer(body);
    const { lastId } = await db.run(`INSERT INTO customers (${CUSTOMER_COLS.join(',')}) VALUES (${CUSTOMER_COLS.map(() => '?').join(',')})`,
      ...CUSTOMER_COLS.map((k) => c[k]));
    return json({ id: lastId }, 201);
  });

  route('GET', '/customers/:id', async ({ params }) => {
    const id = intId(params.id);
    const customer = await db.get('SELECT * FROM customers WHERE id = ?', id);
    if (!customer) throw new HttpError(404, 'Customer not found');
    const loans = await withBalances(await db.all('SELECT * FROM loans WHERE customer_id = ? ORDER BY start_date DESC, id DESC', id));
    return json({ ...customer, loans, documents: await documentsFor('customer', id) });
  });

  route('PUT', '/customers/:id', async ({ params, body }) => {
    const id = intId(params.id);
    const c = readCustomer(body);
    const r = await db.run(`UPDATE customers SET ${CUSTOMER_COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ...CUSTOMER_COLS.map((k) => c[k]), id);
    if (!r.changes) throw new HttpError(404, 'Customer not found');
    return json({ ok: true });
  });

  route('DELETE', '/customers/:id', async ({ params }) => {
    const id = intId(params.id);
    if (await db.get('SELECT 1 AS x FROM loans WHERE customer_id = ?', id)) throw bad('This customer has loans. Delete their loans first.');
    if (!(await db.get('SELECT 1 AS x FROM customers WHERE id = ?', id))) throw new HttpError(404, 'Customer not found');
    await deleteDocuments('customer', id);
    await db.run('DELETE FROM customers WHERE id = ?', id);
    return json({ ok: true });
  });

  // --- loans ---
  const LOAN_COLS = ['customer_id', 'principal', 'interest_rate', 'start_date', 'due_date', 'collateral_type', 'collateral_desc', 'gold_weight_g', 'gold_purity', 'notes'];
  async function readLoan(b) {
    const customer_id = Number(b.customer_id);
    if (!Number.isInteger(customer_id) || !(await db.get('SELECT 1 AS x FROM customers WHERE id = ?', customer_id))) throw bad('Choose a valid customer');
    const start_date = isoDate(b.start_date, 'Loan date', true);
    const due_date = isoDate(b.due_date, 'Due date');
    if (due_date && due_date < start_date) throw bad('Due date cannot be before the loan date');
    return {
      customer_id,
      principal: num(b.principal, 'Loan amount', { required: true, min: 1 }),
      interest_rate: num(b.interest_rate, 'Interest rate', { required: true, min: 0, max: 100 }),
      start_date,
      due_date,
      collateral_type: str(b.collateral_type, 40),
      collateral_desc: str(b.collateral_desc, 1000),
      gold_weight_g: num(b.gold_weight_g, 'Gold weight', { min: 0, max: 100000 }),
      gold_purity: str(b.gold_purity, 20),
      notes: str(b.notes, 2000),
    };
  }

  async function loadLoan(id) {
    const loan = await db.get(`SELECT l.*, c.name AS customer_name, c.phone AS customer_phone
                               FROM loans l JOIN customers c ON c.id = l.customer_id WHERE l.id = ?`, id);
    if (!loan) throw new HttpError(404, 'Loan not found');
    return loan;
  }

  route('GET', '/loans', async ({ url }) => {
    const q = str(url.searchParams.get('q'), 100);
    const s = url.searchParams.get('status');
    const status = ['active', 'closed'].includes(s) ? s : s === 'overdue' ? 'active' : null;
    const like = `%${q || ''}%`;
    let rows = await withBalances(await db.all(`
      SELECT l.*, c.name AS customer_name, c.phone AS customer_phone
      FROM loans l JOIN customers c ON c.id = l.customer_id
      WHERE (? IS NULL OR l.status = ?)
        AND (? IS NULL OR c.name LIKE ? OR c.phone LIKE ? OR l.loan_no LIKE ?)
      ORDER BY l.start_date DESC, l.id DESC`, status, status, q, like, like, like));
    if (s === 'overdue') rows = rows.filter((r) => r.overdue);
    return json(rows);
  });

  route('POST', '/loans', async ({ body }) => {
    const l = await readLoan(body);
    const { lastId } = await db.run(`INSERT INTO loans (${LOAN_COLS.join(',')}) VALUES (${LOAN_COLS.map(() => '?').join(',')})`,
      ...LOAN_COLS.map((k) => l[k]));
    await db.run("UPDATE loans SET loan_no = 'SL-' || substr(start_date, 1, 4) || '-' || printf('%04d', id) WHERE id = ?", lastId);
    return json({ id: lastId }, 201);
  });

  route('GET', '/loans/:id', async ({ params }) => {
    const loan = await loadLoan(intId(params.id));
    const [withBal] = await withBalances([loan]);
    return json({
      ...withBal,
      payments: await db.all('SELECT * FROM payments WHERE loan_id = ? ORDER BY paid_on, id', loan.id),
      documents: await documentsFor('loan', loan.id),
    });
  });

  route('PUT', '/loans/:id', async ({ params, body }) => {
    const id = intId(params.id);
    await loadLoan(id);
    const l = await readLoan(body);
    await db.run(`UPDATE loans SET ${LOAN_COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ...LOAN_COLS.map((k) => l[k]), id);
    return json({ ok: true });
  });

  route('POST', '/loans/:id/close', async ({ params, body }) => {
    const loan = await loadLoan(intId(params.id));
    const date = isoDate(body.closed_date, 'Closing date') || todayIso();
    if (date < loan.start_date) throw bad('Closing date cannot be before the loan date');
    await db.run("UPDATE loans SET status = 'closed', closed_date = ?, updated_at = datetime('now') WHERE id = ?", date, loan.id);
    return json({ ok: true });
  });

  route('POST', '/loans/:id/reopen', async ({ params }) => {
    const loan = await loadLoan(intId(params.id));
    await db.run("UPDATE loans SET status = 'active', closed_date = NULL, updated_at = datetime('now') WHERE id = ?", loan.id);
    return json({ ok: true });
  });

  route('DELETE', '/loans/:id', async ({ params }) => {
    const loan = await loadLoan(intId(params.id));
    await deleteDocuments('loan', loan.id);
    await db.run('DELETE FROM loans WHERE id = ?', loan.id);
    return json({ ok: true });
  });

  // --- payments ---
  route('POST', '/loans/:id/payments', async ({ params, body }) => {
    const loan = await loadLoan(intId(params.id));
    const paid_on = isoDate(body.paid_on, 'Payment date', true);
    if (paid_on < loan.start_date) throw bad('Payment date cannot be before the loan date');
    const amount = num(body.amount, 'Amount', { required: true, min: 0.01 });
    const { lastId } = await db.run('INSERT INTO payments (loan_id, paid_on, amount, mode, note) VALUES (?, ?, ?, ?, ?)',
      loan.id, paid_on, amount, str(body.mode, 30), str(body.note, 500));
    return json({ id: lastId }, 201);
  });

  route('DELETE', '/payments/:id', async ({ params }) => {
    const r = await db.run('DELETE FROM payments WHERE id = ?', intId(params.id));
    if (!r.changes) throw new HttpError(404, 'Payment not found');
    return json({ ok: true });
  });

  // --- documents (ID scans, gold photos) ---
  route('POST', '/documents', async ({ req }) => {
    if (Number(req.headers.get('content-length') || 0) > MAX_UPLOAD + 64 * 1024) throw new HttpError(413, 'File is too large (max 10 MB)');
    let form;
    try { form = await req.formData(); } catch { throw bad('Invalid upload'); }
    const owner_type = form.get('owner_type');
    const owner_id = Number(form.get('owner_id'));
    const file = form.get('file');
    if (!['customer', 'loan'].includes(owner_type) || !Number.isInteger(owner_id)) throw bad('Invalid upload');
    const table = owner_type === 'customer' ? 'customers' : 'loans';
    if (!(await db.get(`SELECT 1 AS x FROM ${table} WHERE id = ?`, owner_id))) throw new HttpError(404, 'Not found');
    if (!file || typeof file === 'string' || !file.size) throw bad('Choose a file to upload');
    if (file.size > MAX_UPLOAD) throw new HttpError(413, 'File is too large (max 10 MB)');
    const ext = UPLOAD_TYPES[file.type];
    if (!ext) throw bad('Only photos (JPG, PNG, WEBP, GIF) and PDF files can be uploaded');
    const key = `${owner_type}/${owner_id}/${randomHex(12)}.${ext}`;
    await files.put(key, await file.arrayBuffer(), file.type);
    const filename = (str(file.name, 200) || `upload.${ext}`).replace(/[\r\n"\\/]/g, '_');
    const { lastId } = await db.run(
      'INSERT INTO documents (owner_type, owner_id, label, filename, content_type, size, storage_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      owner_type, owner_id, str(form.get('label'), 80), filename, file.type, file.size, key);
    return json({ id: lastId }, 201);
  });

  route('GET', '/documents/:id/file', async ({ params, url }) => {
    const doc = await db.get('SELECT * FROM documents WHERE id = ?', intId(params.id));
    if (!doc) throw new HttpError(404, 'File not found');
    const obj = await files.get(doc.storage_key);
    if (!obj) throw new HttpError(404, 'File not found');
    const disposition = url.searchParams.get('download') ? 'attachment' : 'inline';
    return new Response(obj.body, {
      headers: {
        'Content-Type': doc.content_type,
        'Content-Disposition': `${disposition}; filename="${encodeURIComponent(doc.filename)}"`,
        'Cache-Control': 'private, max-age=3600',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });

  route('DELETE', '/documents/:id', async ({ params }) => {
    const doc = await db.get('SELECT * FROM documents WHERE id = ?', intId(params.id));
    if (!doc) throw new HttpError(404, 'File not found');
    await files.delete(doc.storage_key);
    await db.run('DELETE FROM documents WHERE id = ?', doc.id);
    return json({ ok: true });
  });

  // --- dashboard ---
  route('GET', '/dashboard', async () => {
    const active = await withBalances(await db.all(`SELECT l.*, c.name AS customer_name, c.phone AS customer_phone
                               FROM loans l JOIN customers c ON c.id = l.customer_id WHERE l.status = 'active'`));
    const sum = (k) => Math.round(active.reduce((a, l) => a + l[k], 0) * 100) / 100;
    const month = todayIso().slice(0, 7);
    return json({
      customers: (await db.get('SELECT COUNT(*) AS n FROM customers')).n,
      active_loans: active.length,
      closed_loans: (await db.get("SELECT COUNT(*) AS n FROM loans WHERE status = 'closed'")).n,
      outstanding_principal: sum('outstanding_principal'),
      interest_due: sum('interest_due'),
      total_due: sum('total_due'),
      gold_weight_g: Math.round(active.reduce((a, l) => a + (l.gold_weight_g || 0), 0) * 1000) / 1000,
      collected_this_month: (await db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE substr(paid_on, 1, 7) = ?', month)).s,
      lent_this_month: (await db.get('SELECT COALESCE(SUM(principal), 0) AS s FROM loans WHERE substr(start_date, 1, 7) = ?', month)).s,
      overdue: active.filter((l) => l.overdue).sort((a, b) => (a.due_date < b.due_date ? -1 : 1)).slice(0, 20),
      recent_payments: await db.all(`SELECT p.*, l.loan_no, l.id AS loan_id, c.name AS customer_name
                                     FROM payments p JOIN loans l ON l.id = p.loan_id JOIN customers c ON c.id = l.customer_id
                                     ORDER BY p.paid_on DESC, p.id DESC LIMIT 10`),
    });
  });

  // --- backup ---
  route('GET', '/export', async () => json({
    app: 'swarna-live',
    exported_at: new Date().toISOString(),
    customers: await db.all('SELECT * FROM customers ORDER BY id'),
    loans: await db.all('SELECT * FROM loans ORDER BY id'),
    payments: await db.all('SELECT * FROM payments ORDER BY id'),
    documents: await db.all('SELECT * FROM documents ORDER BY id'),
  }, 200, { 'Content-Disposition': `attachment; filename="swarna-live-backup-${todayIso()}.json"` }));

  // --- dispatcher ---
  /** Handle a request whose path starts with /api/. `ip` is the client address. */
  return async function handleApi(req, { ip = 'unknown' } = {}) {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api/, '') || '/';
      let match = null;
      let allowed = false;
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        allowed = true;
        if (r.method === req.method) { match = { r, params: m.groups || {} }; break; }
      }
      if (!match) throw new HttpError(allowed ? 405 : 404, allowed ? 'Method not allowed' : 'Not found');

      // Same-origin check for state-changing requests (defence in depth on top of SameSite cookies).
      if (req.method !== 'GET') {
        const origin = req.headers.get('origin');
        if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked');
      }

      const ctx = { req, url, params: match.params, ip, body: {} };
      if (match.r.auth) {
        ctx.user = await currentUser(req);
        if (!ctx.user) throw new HttpError(401, 'Please log in');
      }
      const type = req.headers.get('content-type') || '';
      if (req.method !== 'GET' && type.includes('application/json')) ctx.body = await readJson(req);
      return await match.r.handler(ctx);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return json({ error: status < 500 ? err.message : 'Something went wrong' }, status);
    }
  };
}

// Security headers for every HTML/JS/CSS page (also in public/_headers for Cloudflare).
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};
