'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { openDb } = require('./db');
const { computeLoan, todayIso } = require('./loanmath');

const SESSION_DAYS = 7;
const COOKIE = 'sl_session';

// ---------- helpers ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

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

function maskId(idNumber) {
  if (!idNumber) return null;
  const s = String(idNumber);
  return s.length <= 4 ? s : '•'.repeat(Math.min(8, s.length - 4)) + s.slice(-4);
}

// ---------- app ----------

function createApp({ dbFile = process.env.SWARNA_DB || path.join(__dirname, 'data', 'swarna.db'), secureCookies = process.env.COOKIE_SECURE === '1' } = {}) {
  const db = openDb(dbFile);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  // --- sessions ---
  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + SESSION_DAYS * 86400000;
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
    res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secureCookies ? '; Secure' : ''}`);
  }

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    return db.prepare(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
                       WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), Date.now()) || null;
  }

  // simple in-memory login throttle: 10 failures per 15 minutes per IP
  const failures = new Map();
  function throttle(req) {
    const key = req.ip;
    const now = Date.now();
    const rec = (failures.get(key) || []).filter((t) => now - t < 15 * 60000);
    failures.set(key, rec);
    if (rec.length >= 10) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    return () => rec.push(now);
  }

  const api = express.Router();

  api.get('/status', (req, res) => {
    res.json({ setupNeeded: userCount() === 0, user: currentUser(req) });
  });

  api.post('/setup', (req, res) => {
    if (userCount() > 0) throw new HttpError(403, 'Setup already completed');
    const username = str(req.body.username, 50);
    const password = String(req.body.password || '');
    if (!username) throw bad('Username is required');
    if (password.length < 8) throw bad('Password must be at least 8 characters');
    const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
    startSession(res, Number(lastInsertRowid));
    res.json({ ok: true });
  });

  api.post('/login', (req, res) => {
    const fail = throttle(req);
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username || '').trim());
    if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      fail();
      throw new HttpError(401, 'Wrong username or password');
    }
    startSession(res, user.id);
    res.json({ ok: true });
  });

  api.post('/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  // everything below needs a logged-in user
  api.use((req, res, next) => {
    const user = currentUser(req);
    if (!user) return next(new HttpError(401, 'Please log in'));
    req.user = user;
    next();
  });

  api.post('/password', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body.current || ''), user.password_hash)) throw bad('Current password is wrong');
    const next = String(req.body.password || '');
    if (next.length < 8) throw bad('New password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
    res.json({ ok: true });
  });

  api.get('/users', (req, res) => {
    res.json(db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all());
  });

  api.post('/users', (req, res) => {
    const username = str(req.body.username, 50);
    const password = String(req.body.password || '');
    if (!username) throw bad('Username is required');
    if (password.length < 8) throw bad('Password must be at least 8 characters');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('That username is taken');
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
    res.json({ ok: true });
  });

  // --- loans: shared helpers ---
  const paymentsFor = db.prepare('SELECT * FROM payments WHERE loan_id = ? ORDER BY paid_on, id');
  const withBalance = (loan) => ({ ...loan, ...computeLoan(loan, paymentsFor.all(loan.id)) });

  // --- customers ---
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
  const CUSTOMER_COLS = ['name', 'guardian_name', 'phone', 'alt_phone', 'email', 'dob', 'address', 'id_type', 'id_number', 'id_type_2', 'id_number_2', 'notes'];

  api.get('/customers', (req, res) => {
    const q = str(req.query.q, 100);
    const like = `%${q || ''}%`;
    const rows = db.prepare(`
      SELECT c.id, c.name, c.phone, c.id_type, c.id_number, c.created_at,
             (SELECT COUNT(*) FROM loans l WHERE l.customer_id = c.id AND l.status = 'active') AS active_loans,
             (SELECT COUNT(*) FROM loans l WHERE l.customer_id = c.id) AS total_loans
      FROM customers c
      WHERE ? IS NULL OR c.name LIKE ? OR c.phone LIKE ? OR c.alt_phone LIKE ? OR c.id_number LIKE ? OR c.id_number_2 LIKE ?
      ORDER BY c.name COLLATE NOCASE`).all(q, like, like, like, like, like);
    res.json(rows.map(({ id_number, ...r }) => ({ ...r, id_number_masked: maskId(id_number) })));
  });

  api.post('/customers', (req, res) => {
    const c = readCustomer(req.body);
    const { lastInsertRowid } = db.prepare(`INSERT INTO customers (${CUSTOMER_COLS.join(',')}) VALUES (${CUSTOMER_COLS.map(() => '?').join(',')})`)
      .run(...CUSTOMER_COLS.map((k) => c[k]));
    res.status(201).json({ id: Number(lastInsertRowid) });
  });

  api.get('/customers/:id', (req, res) => {
    const id = intId(req.params.id);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!customer) throw new HttpError(404, 'Customer not found');
    const loans = db.prepare('SELECT * FROM loans WHERE customer_id = ? ORDER BY start_date DESC, id DESC').all(id).map(withBalance);
    res.json({ ...customer, loans });
  });

  api.put('/customers/:id', (req, res) => {
    const id = intId(req.params.id);
    const c = readCustomer(req.body);
    const r = db.prepare(`UPDATE customers SET ${CUSTOMER_COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...CUSTOMER_COLS.map((k) => c[k]), id);
    if (!r.changes) throw new HttpError(404, 'Customer not found');
    res.json({ ok: true });
  });

  api.delete('/customers/:id', (req, res) => {
    const id = intId(req.params.id);
    if (db.prepare('SELECT 1 FROM loans WHERE customer_id = ?').get(id)) throw bad('This customer has loans. Delete their loans first.');
    const r = db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    if (!r.changes) throw new HttpError(404, 'Customer not found');
    res.json({ ok: true });
  });

  // --- loans ---
  function readLoan(b) {
    const customer_id = Number(b.customer_id);
    if (!Number.isInteger(customer_id) || !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customer_id)) throw bad('Choose a valid customer');
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
  const LOAN_COLS = ['customer_id', 'principal', 'interest_rate', 'start_date', 'due_date', 'collateral_type', 'collateral_desc', 'gold_weight_g', 'gold_purity', 'notes'];

  api.get('/loans', (req, res) => {
    const q = str(req.query.q, 100);
    const status = ['active', 'closed'].includes(req.query.status) ? req.query.status : null;
    const like = `%${q || ''}%`;
    let rows = db.prepare(`
      SELECT l.*, c.name AS customer_name, c.phone AS customer_phone
      FROM loans l JOIN customers c ON c.id = l.customer_id
      WHERE (? IS NULL OR l.status = ?)
        AND (? IS NULL OR c.name LIKE ? OR c.phone LIKE ? OR l.loan_no LIKE ?)
      ORDER BY l.start_date DESC, l.id DESC`).all(status, status, q, like, like, like).map(withBalance);
    if (req.query.status === 'overdue') rows = rows.filter((r) => r.overdue);
    res.json(rows);
  });

  api.post('/loans', (req, res) => {
    const l = readLoan(req.body);
    db.exec('BEGIN');
    try {
      const { lastInsertRowid } = db.prepare(`INSERT INTO loans (${LOAN_COLS.join(',')}) VALUES (${LOAN_COLS.map(() => '?').join(',')})`)
        .run(...LOAN_COLS.map((k) => l[k]));
      const id = Number(lastInsertRowid);
      db.prepare('UPDATE loans SET loan_no = ? WHERE id = ?').run(`SL-${l.start_date.slice(0, 4)}-${String(id).padStart(4, '0')}`, id);
      db.exec('COMMIT');
      res.status(201).json({ id });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });

  function loadLoan(id) {
    const loan = db.prepare(`SELECT l.*, c.name AS customer_name, c.phone AS customer_phone
                             FROM loans l JOIN customers c ON c.id = l.customer_id WHERE l.id = ?`).get(id);
    if (!loan) throw new HttpError(404, 'Loan not found');
    return loan;
  }

  api.get('/loans/:id', (req, res) => {
    const loan = loadLoan(intId(req.params.id));
    res.json({ ...withBalance(loan), payments: paymentsFor.all(loan.id) });
  });

  api.put('/loans/:id', (req, res) => {
    const id = intId(req.params.id);
    loadLoan(id);
    const l = readLoan(req.body);
    db.prepare(`UPDATE loans SET ${LOAN_COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...LOAN_COLS.map((k) => l[k]), id);
    res.json({ ok: true });
  });

  api.post('/loans/:id/close', (req, res) => {
    const loan = loadLoan(intId(req.params.id));
    const date = isoDate(req.body.closed_date, 'Closing date') || todayIso();
    if (date < loan.start_date) throw bad('Closing date cannot be before the loan date');
    db.prepare("UPDATE loans SET status = 'closed', closed_date = ?, updated_at = datetime('now') WHERE id = ?").run(date, loan.id);
    res.json({ ok: true });
  });

  api.post('/loans/:id/reopen', (req, res) => {
    const loan = loadLoan(intId(req.params.id));
    db.prepare("UPDATE loans SET status = 'active', closed_date = NULL, updated_at = datetime('now') WHERE id = ?").run(loan.id);
    res.json({ ok: true });
  });

  api.delete('/loans/:id', (req, res) => {
    const r = db.prepare('DELETE FROM loans WHERE id = ?').run(intId(req.params.id));
    if (!r.changes) throw new HttpError(404, 'Loan not found');
    res.json({ ok: true });
  });

  // --- payments ---
  api.post('/loans/:id/payments', (req, res) => {
    const loan = loadLoan(intId(req.params.id));
    const paid_on = isoDate(req.body.paid_on, 'Payment date', true);
    if (paid_on < loan.start_date) throw bad('Payment date cannot be before the loan date');
    const amount = num(req.body.amount, 'Amount', { required: true, min: 0.01 });
    const { lastInsertRowid } = db.prepare('INSERT INTO payments (loan_id, paid_on, amount, mode, note) VALUES (?, ?, ?, ?, ?)')
      .run(loan.id, paid_on, amount, str(req.body.mode, 30), str(req.body.note, 500));
    res.status(201).json({ id: Number(lastInsertRowid) });
  });

  api.delete('/payments/:id', (req, res) => {
    const r = db.prepare('DELETE FROM payments WHERE id = ?').run(intId(req.params.id));
    if (!r.changes) throw new HttpError(404, 'Payment not found');
    res.json({ ok: true });
  });

  // --- dashboard ---
  api.get('/dashboard', (req, res) => {
    const active = db.prepare(`SELECT l.*, c.name AS customer_name, c.phone AS customer_phone
                               FROM loans l JOIN customers c ON c.id = l.customer_id WHERE l.status = 'active'`).all().map(withBalance);
    const sum = (k) => Math.round(active.reduce((a, l) => a + l[k], 0) * 100) / 100;
    const month = todayIso().slice(0, 7);
    res.json({
      customers: db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
      active_loans: active.length,
      closed_loans: db.prepare("SELECT COUNT(*) AS n FROM loans WHERE status = 'closed'").get().n,
      outstanding_principal: sum('outstanding_principal'),
      interest_due: sum('interest_due'),
      total_due: sum('total_due'),
      gold_weight_g: Math.round(active.reduce((a, l) => a + (l.gold_weight_g || 0), 0) * 1000) / 1000,
      collected_this_month: db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE substr(paid_on, 1, 7) = ?').get(month).s,
      lent_this_month: db.prepare('SELECT COALESCE(SUM(principal), 0) AS s FROM loans WHERE substr(start_date, 1, 7) = ?').get(month).s,
      overdue: active.filter((l) => l.overdue).sort((a, b) => (a.due_date < b.due_date ? -1 : 1)).slice(0, 20),
      recent_payments: db.prepare(`SELECT p.*, l.loan_no, l.id AS loan_id, c.name AS customer_name
                                   FROM payments p JOIN loans l ON l.id = p.loan_id JOIN customers c ON c.id = l.customer_id
                                   ORDER BY p.paid_on DESC, p.id DESC LIMIT 10`).all(),
    });
  });

  // --- backup ---
  api.get('/export', (req, res) => {
    const data = {
      app: 'swarna-live',
      exported_at: new Date().toISOString(),
      customers: db.prepare('SELECT * FROM customers ORDER BY id').all(),
      loans: db.prepare('SELECT * FROM loans ORDER BY id').all(),
      payments: db.prepare('SELECT * FROM payments ORDER BY id').all(),
    };
    res.set('Content-Disposition', `attachment; filename="swarna-live-backup-${todayIso()}.json"`);
    res.json(data);
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || 500;
    let message = status < 500 ? err.message : 'Something went wrong';
    if (err.type === 'entity.parse.failed') { status = 400; message = 'Invalid request'; }
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  });

  app.locals.db = db;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createApp().listen(port, host, () => console.log(`Swarna Live running at http://${host}:${port}`));
}

module.exports = { createApp, maskId };
