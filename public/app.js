'use strict';

// ---------- tiny helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Tagged template that escapes every interpolated value unless it is Raw (or an array of Raw).
function h(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('');
    else out += v instanceof Raw ? v.s : esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = (n) => inr.format(Number(n) || 0);
const fmtDate = (iso) => {
  if (!iso) return '—';
  // "YYYY-MM-DD HH:MM:SS" timestamps are stored in UTC; plain dates are local.
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const date = iso.length > 10 ? new Date(iso.replace(' ', 'T') + 'Z') : new Date(y, m - 1, d);
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3200);
}

async function api(path, { method = 'GET', body } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch('/api' + path, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : {},
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && path !== '/login') { state.user = null; renderAuth(); throw new Error('Please log in'); }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function formData(form) {
  const o = {};
  for (const [k, v] of new FormData(form).entries()) o[k] = typeof v === 'string' ? v.trim() : v;
  return o;
}

function setTitle(t) { document.title = t ? `${t} · Swarna Live` : 'Swarna Live'; }

// ---------- constants ----------

const ID_TYPES = ['Aadhaar Card', 'PAN Card', 'Voter ID', 'Driving Licence', 'Passport', 'Ration Card', 'Other'];
const COLLATERAL_TYPES = ['Gold', 'Silver', 'Property Documents', 'Vehicle', 'None', 'Other'];
const PURITIES = ['24K', '22K', '20K', '18K', '916', 'Other'];
const PAY_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Other'];

const options = (list, selected, blank = '— Select —') =>
  raw(`<option value="">${esc(blank)}</option>` + list.map((o) => `<option${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join(''));

// ---------- state & shell ----------

const state = { user: null, setupNeeded: false, setupCodeRequired: false };

function shell(content, active) {
  const link = (href, label, key) => h`<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
  app.innerHTML = h`
    <header class="topbar"><div class="topbar-inner">
      <a class="brand" href="#/"><span class="logo">S</span><span>Swarna Live</span></a>
      <nav class="nav">
        ${link('#/', 'Dashboard', 'dash')}
        ${link('#/customers', 'Customers', 'customers')}
        ${link('#/loans', 'Loans', 'loans')}
        ${link('#/settings', 'Settings', 'settings')}
      </nav>
      <div class="user-menu"><span class="who">${state.user.username}</span>
        <button class="btn sm" data-action="logout">Log out</button></div>
    </div></header>
    <main>${content}</main>`.s;
}

function renderAuth() {
  const setup = state.setupNeeded;
  setTitle(setup ? 'Set up' : 'Log in');
  app.innerHTML = h`
    <div class="auth"><div class="card">
      <div class="brand"><span class="logo">S</span><span>Swarna Live</span></div>
      <p class="lead">${setup ? 'Create the first admin account to get started.' : 'Log in to manage loan records.'}</p>
      <form id="auth-form">
        <div class="form-error"></div>
        <div class="fields">
          ${setup && state.setupCodeRequired ? h`<div><label for="sc">Setup code</label><input id="sc" name="setup_code" autocomplete="off" required>
            <div class="help">The code you were given when the site was installed.</div></div>` : ''}
          <div><label for="u">Username</label><input id="u" name="username" autocomplete="username" required></div>
          <div><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required ${setup ? raw('minlength="8"') : ''}>
            ${setup ? h`<div class="help">At least 8 characters.</div>` : ''}</div>
          <button class="btn primary" type="submit">${setup ? 'Create account' : 'Log in'}</button>
        </div>
      </form>
    </div></div>`.s;
  ($('#sc') || $('#u')).focus();
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', e.target);
    err.textContent = '';
    try {
      await api(setup ? '/setup' : '/login', { method: 'POST', body: formData(e.target) });
      await boot();
    } catch (ex) { err.textContent = ex.message; }
  });
}

// ---------- documents (ID scans, gold photos) ----------

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function documentsCard(ownerType, ownerId, docs, suggestions) {
  return h`<div class="card mt"><div class="card-head"><h2>${ownerType === 'customer' ? 'ID proofs & photos' : 'Photos of pledged items'}</h2></div>
    <div class="card-pad">
      ${docs.length ? h`<div class="docs">${docs.map((d) => h`<figure class="doc">
          <a href="/api/documents/${d.id}/file" target="_blank" rel="noopener" class="doc-thumb">
            ${d.content_type.startsWith('image/') ? h`<img src="/api/documents/${d.id}/file" alt="${d.label || d.filename}" loading="lazy">` : h`<span class="doc-pdf">PDF</span>`}</a>
          <figcaption><strong>${d.label || d.filename}</strong><span class="muted small">${fmtSize(d.size)} · ${fmtDate(d.created_at)}</span>
            <button class="btn link sm" data-action="delete-doc" data-id="${d.id}">Remove</button></figcaption></figure>`)}</div>`
        : h`<p class="muted">Nothing uploaded yet.</p>`}
      <form class="doc-form" data-owner-type="${ownerType}" data-owner-id="${ownerId}">
        <div><label for="doc-label">What is it?</label><input id="doc-label" name="label" list="doc-labels" maxlength="80" placeholder="${suggestions[0]}">
          <datalist id="doc-labels">${suggestions.map((x) => h`<option value="${x}">`)}</datalist></div>
        <div><label for="doc-file">File (photo or PDF, max 10 MB)</label><input id="doc-file" name="file" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" required></div>
        <button class="btn primary" type="submit">Upload</button>
      </form>
    </div></div>`;
}

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('.doc-form');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  fd.set('owner_type', form.dataset.ownerType);
  fd.set('owner_id', form.dataset.ownerId);
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try { await api('/documents', { method: 'POST', body: fd }); toast('File uploaded'); route(); }
  catch (ex) { toast(ex.message, true); btn.disabled = false; btn.textContent = 'Upload'; }
});

// ---------- pages ----------

function loanStatusBadge(l) {
  if (l.status === 'closed') return h`<span class="badge closed">Closed</span>`;
  if (l.overdue) return h`<span class="badge overdue">Overdue</span>`;
  return h`<span class="badge active">Active</span>`;
}

function loanRows(loans, { showCustomer = true } = {}) {
  if (!loans.length) return h`<div class="empty">No loans found.</div>`;
  return h`<div class="table-wrap"><table>
    <thead><tr><th>Loan no.</th>${showCustomer ? h`<th>Customer</th>` : ''}<th class="hide-sm">Date</th><th class="hide-sm">Due</th>
      <th class="num hide-sm">Amount</th><th class="num hide-sm">Rate</th><th class="num">Balance due</th><th>Status</th></tr></thead>
    <tbody>${loans.map((l) => h`<tr class="clickable" data-href="#/loans/${l.id}">
      <td class="nowrap"><a href="#/loans/${l.id}">${l.loan_no}</a></td>
      ${showCustomer ? h`<td>${l.customer_name}<div class="muted small">${l.customer_phone}</div></td>` : ''}
      <td class="hide-sm">${fmtDate(l.start_date)}</td><td class="hide-sm">${fmtDate(l.due_date)}</td>
      <td class="num hide-sm">${money(l.principal)}</td><td class="num hide-sm">${l.interest_rate}%</td>
      <td class="num"><strong>${money(l.total_due)}</strong></td><td>${loanStatusBadge(l)}</td></tr>`)}</tbody>
  </table></div>`;
}

async function pageDashboard() {
  setTitle('Dashboard');
  const d = await api('/dashboard');
  shell(h`
    <div class="page-head"><div><h1>Dashboard</h1><div class="sub">Summary of all active loans as of ${fmtDate(today())}</div></div>
      <div class="actions"><a class="btn" href="#/customers/new">+ New customer</a><a class="btn primary" href="#/loans/new">+ New loan</a></div></div>
    <div class="stats">
      <div class="card stat"><div class="label">Amount lent out</div><div class="value">${money(d.outstanding_principal)}</div><div class="hint">${d.active_loans} active ${d.active_loans === 1 ? 'loan' : 'loans'}</div></div>
      <div class="card stat"><div class="label">Interest due</div><div class="value">${money(d.interest_due)}</div><div class="hint">Accrued, not yet paid</div></div>
      <div class="card stat"><div class="label">Total receivable</div><div class="value gold">${money(d.total_due)}</div><div class="hint">Principal + interest</div></div>
      <div class="card stat"><div class="label">Gold held</div><div class="value">${d.gold_weight_g} g</div><div class="hint">Against active loans</div></div>
      <div class="card stat"><div class="label">Collected this month</div><div class="value">${money(d.collected_this_month)}</div><div class="hint">Lent this month: ${money(d.lent_this_month)}</div></div>
      <div class="card stat"><div class="label">Customers</div><div class="value">${d.customers}</div><div class="hint">${d.closed_loans} loans closed</div></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><div class="card-head"><h2>Overdue loans</h2><a class="small" href="#/loans?status=overdue">View all</a></div>
        ${d.overdue.length ? h`<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Due</th><th class="num">Balance</th></tr></thead>
          <tbody>${d.overdue.map((l) => h`<tr class="clickable" data-href="#/loans/${l.id}"><td>${l.customer_name}<div class="muted small">${l.loan_no} · ${l.customer_phone}</div></td>
            <td>${fmtDate(l.due_date)}</td><td class="num">${money(l.total_due)}</td></tr>`)}</tbody></table></div>`
          : h`<div class="empty">No overdue loans. 🎉</div>`}
      </div>
      <div class="card"><div class="card-head"><h2>Recent payments</h2></div>
        ${d.recent_payments.length ? h`<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Date</th><th class="num">Amount</th></tr></thead>
          <tbody>${d.recent_payments.map((p) => h`<tr class="clickable" data-href="#/loans/${p.loan_id}"><td>${p.customer_name}<div class="muted small">${p.loan_no}${p.mode ? ' · ' + p.mode : ''}</div></td>
            <td>${fmtDate(p.paid_on)}</td><td class="num">${money(p.amount)}</td></tr>`)}</tbody></table></div>`
          : h`<div class="empty">No payments recorded yet.</div>`}
      </div>
    </div>`, 'dash');
}

async function pageCustomers(params) {
  setTitle('Customers');
  const q = params.get('q') || '';
  const list = await api('/customers' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  shell(h`
    <div class="page-head"><div><h1>Customers</h1><div class="sub">${list.length} ${list.length === 1 ? 'customer' : 'customers'}${q ? ` matching “${q}”` : ''}</div></div>
      <div class="actions"><a class="btn primary" href="#/customers/new">+ New customer</a></div></div>
    <form class="search" id="search"><input name="q" type="search" placeholder="Search by name, phone or ID number" value="${q}"><button class="btn">Search</button></form>
    <div class="card">${list.length ? h`<div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Phone</th><th class="hide-sm">ID proof</th><th class="num">Active loans</th><th class="num hide-sm">All loans</th></tr></thead>
      <tbody>${list.map((c) => h`<tr class="clickable" data-href="#/customers/${c.id}">
        <td><a href="#/customers/${c.id}">${c.name}</a></td><td>${c.phone}</td>
        <td class="hide-sm">${c.id_type ? h`${c.id_type} <span class="muted reveal">${c.id_number_masked || ''}</span>` : h`<span class="muted">—</span>`}</td>
        <td class="num">${c.active_loans}</td><td class="num hide-sm">${c.total_loans}</td></tr>`)}</tbody></table></div>`
      : h`<div class="empty">${q ? 'No customers match your search.' : raw('No customers yet. <a href="#/customers/new">Add the first one</a>.')}</div>`}</div>`, 'customers');
  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formData(e.target).q;
    location.hash = '#/customers' + (v ? `?q=${encodeURIComponent(v)}` : '');
  });
}

function customerForm(c = {}) {
  const f = (name, label, attrs = '', req = false, help = '') => h`
    <div><label for="f-${name}">${label}${req ? raw(' <span class="req">*</span>') : ''}</label>
      <input id="f-${name}" name="${name}" value="${c[name] || ''}" ${raw(attrs)} ${req ? raw('required') : ''}>
      ${help ? h`<div class="help">${help}</div>` : ''}</div>`;
  return h`
    <form id="customer-form" class="card card-pad" autocomplete="off">
      <div class="form-error"></div>
      <fieldset><legend>Personal details</legend><div class="fields">
        ${f('name', 'Full name', 'maxlength="120"', true)}
        ${f('guardian_name', 'Father / Husband name', 'maxlength="120"')}
        ${f('phone', 'Phone number', 'type="tel" inputmode="tel" maxlength="20" placeholder="98765 43210"', true)}
        ${f('alt_phone', 'Alternate phone', 'type="tel" inputmode="tel" maxlength="20"')}
        ${f('email', 'Email', 'type="email" maxlength="120"')}
        ${f('dob', 'Date of birth', 'type="date"')}
        <div class="full"><label for="f-address">Address</label><textarea id="f-address" name="address" maxlength="500">${c.address || ''}</textarea></div>
      </div></fieldset>
      <fieldset><legend>Identity proof</legend><div class="fields">
        <div><label for="f-id_type">Primary ID type</label><select id="f-id_type" name="id_type">${options(ID_TYPES, c.id_type)}</select></div>
        ${f('id_number', 'Primary ID number', 'maxlength="40"')}
        <div><label for="f-id_type_2">Second ID type</label><select id="f-id_type_2" name="id_type_2">${options(ID_TYPES, c.id_type_2)}</select></div>
        ${f('id_number_2', 'Second ID number', 'maxlength="40"')}
      </div></fieldset>
      <fieldset><legend>Notes</legend>
        <textarea name="notes" maxlength="2000" placeholder="Anything else worth remembering about this customer">${c.notes || ''}</textarea>
      </fieldset>
      <div class="form-actions"><a class="btn" href="${c.id ? `#/customers/${c.id}` : '#/customers'}">Cancel</a><button class="btn primary" type="submit">Save customer</button></div>
    </form>`;
}

async function pageCustomerEdit(id) {
  const c = id ? await api(`/customers/${id}`) : {};
  setTitle(id ? `Edit ${c.name}` : 'New customer');
  shell(h`<div class="page-head"><div><h1>${id ? `Edit ${c.name}` : 'New customer'}</h1></div></div>${customerForm(c)}`, 'customers');
  const form = $('#customer-form');
  $('#f-name').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.textContent = '';
    try {
      const body = formData(form);
      if (id) { await api(`/customers/${id}`, { method: 'PUT', body }); toast('Customer updated'); location.hash = `#/customers/${id}`; }
      else { const r = await api('/customers', { method: 'POST', body }); toast('Customer added'); location.hash = `#/customers/${r.id}`; }
    } catch (ex) { err.textContent = ex.message; window.scrollTo(0, 0); }
  });
}

function sensitive(value) {
  if (!value) return '—';
  const masked = value.length <= 4 ? value : '•'.repeat(Math.min(8, value.length - 4)) + value.slice(-4);
  return h`<span class="reveal" data-full="${value}" data-masked="${masked}">${masked}</span> <button class="btn link sm" data-action="reveal">Show</button>`;
}

async function pageCustomer(id) {
  const c = await api(`/customers/${id}`);
  setTitle(c.name);
  const active = c.loans.filter((l) => l.status === 'active');
  const due = active.reduce((a, l) => a + l.total_due, 0);
  shell(h`
    <div class="page-head"><div><h1>${c.name}</h1><div class="sub">Customer since ${fmtDate(c.created_at)}</div></div>
      <div class="actions"><a class="btn" href="#/customers/${c.id}/edit">Edit</a>
        <button class="btn danger" data-action="delete-customer" data-id="${c.id}">Delete</button>
        <a class="btn primary" href="#/loans/new?customer=${c.id}">+ New loan</a></div></div>
    <div class="stats">
      <div class="card stat"><div class="label">Active loans</div><div class="value">${active.length}</div></div>
      <div class="card stat"><div class="label">Balance due</div><div class="value gold">${money(due)}</div></div>
      <div class="card stat"><div class="label">All loans</div><div class="value">${c.loans.length}</div></div>
    </div>
    <div class="grid grid-2">
      <div class="card card-pad"><h2 class="mb">Contact</h2><dl class="details">
        <dt>Phone</dt><dd><a href="tel:${c.phone}">${c.phone}</a></dd>
        <dt>Alternate phone</dt><dd>${c.alt_phone ? h`<a href="tel:${c.alt_phone}">${c.alt_phone}</a>` : '—'}</dd>
        <dt>Email</dt><dd>${dash(c.email)}</dd>
        <dt>Father / Husband</dt><dd>${dash(c.guardian_name)}</dd>
        <dt>Date of birth</dt><dd>${fmtDate(c.dob)}</dd>
        <dt>Address</dt><dd>${dash(c.address)}</dd>
      </dl></div>
      <div class="card card-pad"><h2 class="mb">Identity proof</h2><dl class="details">
        <dt>${c.id_type || 'Primary ID'}</dt><dd>${sensitive(c.id_number)}</dd>
        <dt>${c.id_type_2 || 'Second ID'}</dt><dd>${sensitive(c.id_number_2)}</dd>
        <dt>Notes</dt><dd>${dash(c.notes)}</dd>
      </dl></div>
    </div>
    ${documentsCard('customer', c.id, c.documents, ['Aadhaar front', 'Aadhaar back', 'PAN card', 'Customer photo', 'Voter ID', 'Signature'])}
    <div class="card mt"><div class="card-head"><h2>Loans</h2></div>${loanRows(c.loans, { showCustomer: false })}</div>`, 'customers');
}

async function pageLoans(params) {
  setTitle('Loans');
  const q = params.get('q') || '';
  const status = params.get('status') || '';
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (status) qs.set('status', status);
  const list = await api('/loans' + (qs.toString() ? `?${qs}` : ''));
  const total = list.reduce((a, l) => a + (l.status === 'active' ? l.total_due : 0), 0);
  shell(h`
    <div class="page-head"><div><h1>Loans</h1><div class="sub">${list.length} ${list.length === 1 ? 'loan' : 'loans'} · ${money(total)} receivable</div></div>
      <div class="actions"><a class="btn primary" href="#/loans/new">+ New loan</a></div></div>
    <form class="search" id="search">
      <input name="q" type="search" placeholder="Search by customer, phone or loan number" value="${q}">
      <select name="status">${raw([['', 'All loans'], ['active', 'Active'], ['overdue', 'Overdue'], ['closed', 'Closed']]
        .map(([v, l]) => `<option value="${v}"${v === status ? ' selected' : ''}>${l}</option>`).join(''))}</select>
      <button class="btn">Search</button></form>
    <div class="card">${loanRows(list)}</div>`, 'loans');
  const form = $('#search');
  const go = () => {
    const v = formData(form);
    const p = new URLSearchParams();
    if (v.q) p.set('q', v.q);
    if (v.status) p.set('status', v.status);
    location.hash = '#/loans' + (p.toString() ? `?${p}` : '');
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); go(); });
  $('select', form).addEventListener('change', go);
}

async function pageLoanEdit(id, params) {
  const [loan, customers] = await Promise.all([id ? api(`/loans/${id}`) : null, api('/customers')]);
  const l = loan || { customer_id: Number(params.get('customer')) || '', start_date: today(), collateral_type: 'Gold', interest_rate: '' };
  setTitle(id ? `Edit ${l.loan_no}` : 'New loan');
  if (!customers.length) {
    shell(h`<div class="page-head"><h1>New loan</h1></div><div class="card empty">Add a customer before creating a loan. <a href="#/customers/new">Add customer</a></div>`, 'loans');
    return;
  }
  const v = (k) => (l[k] ?? '');
  shell(h`
    <div class="page-head"><div><h1>${id ? `Edit loan ${l.loan_no}` : 'New loan'}</h1></div></div>
    <form id="loan-form" class="card card-pad" autocomplete="off">
      <div class="form-error"></div>
      <fieldset><legend>Loan details</legend><div class="fields">
        <div class="full"><label for="f-customer">Customer <span class="req">*</span></label>
          <select id="f-customer" name="customer_id" required><option value="">— Select customer —</option>
            ${customers.map((c) => h`<option value="${c.id}" ${String(c.id) === String(l.customer_id) ? raw('selected') : ''}>${c.name} · ${c.phone}</option>`)}
          </select><div class="help">Not listed? <a href="#/customers/new">Add a new customer</a> first.</div></div>
        <div><label for="f-principal">Loan amount (₹) <span class="req">*</span></label>
          <input id="f-principal" name="principal" type="number" min="1" step="0.01" inputmode="decimal" value="${v('principal')}" required></div>
        <div><label for="f-rate">Interest rate (% per month) <span class="req">*</span></label>
          <input id="f-rate" name="interest_rate" type="number" min="0" max="100" step="0.01" inputmode="decimal" value="${v('interest_rate')}" required>
          <div class="help">e.g. 2 means ₹2 per ₹100 per month (24% a year).</div></div>
        <div><label for="f-start">Loan date <span class="req">*</span></label><input id="f-start" name="start_date" type="date" value="${v('start_date')}" required></div>
        <div><label for="f-due">Due date</label><input id="f-due" name="due_date" type="date" value="${v('due_date')}"></div>
      </div></fieldset>
      <fieldset><legend>Security / pledged items</legend><div class="fields">
        <div><label for="f-ctype">Type</label><select id="f-ctype" name="collateral_type">${options(COLLATERAL_TYPES, l.collateral_type)}</select></div>
        <div><label for="f-purity">Gold purity</label><select id="f-purity" name="gold_purity">${options(PURITIES, l.gold_purity)}</select></div>
        <div><label for="f-weight">Weight (grams)</label><input id="f-weight" name="gold_weight_g" type="number" min="0" step="0.001" inputmode="decimal" value="${v('gold_weight_g')}"></div>
        <div class="full"><label for="f-cdesc">Item description</label>
          <textarea id="f-cdesc" name="collateral_desc" maxlength="1000" placeholder="e.g. 2 bangles, 1 chain with pendant">${v('collateral_desc')}</textarea></div>
      </div></fieldset>
      <fieldset><legend>Notes</legend><textarea name="notes" maxlength="2000">${v('notes')}</textarea></fieldset>
      <div class="form-actions"><a class="btn" href="${id ? `#/loans/${id}` : '#/loans'}">Cancel</a><button class="btn primary" type="submit">Save loan</button></div>
    </form>`, 'loans');
  const form = $('#loan-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.textContent = '';
    try {
      const body = formData(form);
      if (id) { await api(`/loans/${id}`, { method: 'PUT', body }); toast('Loan updated'); location.hash = `#/loans/${id}`; }
      else { const r = await api('/loans', { method: 'POST', body }); toast('Loan created'); location.hash = `#/loans/${r.id}`; }
    } catch (ex) { err.textContent = ex.message; window.scrollTo(0, 0); }
  });
}

async function pageLoan(id) {
  const l = await api(`/loans/${id}`);
  setTitle(l.loan_no);
  const closed = l.status === 'closed';
  shell(h`
    <div class="page-head"><div><h1>Loan ${l.loan_no} ${loanStatusBadge(l)}</h1>
        <div class="sub"><a href="#/customers/${l.customer_id}">${l.customer_name}</a> · ${l.customer_phone}</div></div>
      <div class="actions">
        <a class="btn" href="#/loans/${l.id}/edit">Edit</a>
        <button class="btn" data-action="print">Print</button>
        <button class="btn danger" data-action="delete-loan" data-id="${l.id}">Delete</button>
        ${closed ? h`<button class="btn" data-action="reopen-loan" data-id="${l.id}">Reopen</button>`
          : h`<button class="btn" data-action="close-loan" data-id="${l.id}">Close loan</button>
              <button class="btn primary" data-action="add-payment" data-id="${l.id}">+ Record payment</button>`}
      </div></div>
    <div class="stats">
      <div class="card stat"><div class="label">Loan amount</div><div class="value">${money(l.principal)}</div><div class="hint">${l.interest_rate}% per month</div></div>
      <div class="card stat"><div class="label">Principal left</div><div class="value">${money(l.outstanding_principal)}</div><div class="hint">Paid: ${money(l.principal_paid)}</div></div>
      <div class="card stat"><div class="label">Interest due</div><div class="value">${money(l.interest_due)}</div><div class="hint">Earned so far: ${money(l.interest_accrued)}</div></div>
      <div class="card stat"><div class="label">${closed ? 'Balance at closing' : 'Total due today'}</div><div class="value gold">${money(l.total_due)}</div><div class="hint">${l.days_running} days</div></div>
    </div>
    <div class="grid grid-2">
      <div class="card card-pad"><h2 class="mb">Details</h2><dl class="details">
        <dt>Loan date</dt><dd>${fmtDate(l.start_date)}</dd>
        <dt>Due date</dt><dd>${fmtDate(l.due_date)}</dd>
        ${closed ? h`<dt>Closed on</dt><dd>${fmtDate(l.closed_date)}</dd>` : ''}
        <dt>Total paid</dt><dd>${money(l.total_paid)}${l.extra_paid > 0 ? h` <span class="muted">(${money(l.extra_paid)} more than due)</span>` : ''}</dd>
        <dt>Notes</dt><dd>${dash(l.notes)}</dd>
      </dl></div>
      <div class="card card-pad"><h2 class="mb">Security / pledged items</h2><dl class="details">
        <dt>Type</dt><dd>${dash(l.collateral_type)}</dd>
        <dt>Weight</dt><dd>${l.gold_weight_g ? `${l.gold_weight_g} g` : '—'}</dd>
        <dt>Purity</dt><dd>${dash(l.gold_purity)}</dd>
        <dt>Items</dt><dd>${dash(l.collateral_desc)}</dd>
      </dl></div>
    </div>
    <div class="card mt"><div class="card-head"><h2>Payments</h2></div>
      ${l.payments.length ? h`<div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Amount</th><th>Mode</th><th>Note</th><th></th></tr></thead>
        <tbody>${l.payments.map((p) => h`<tr><td>${fmtDate(p.paid_on)}</td><td class="num">${money(p.amount)}</td><td>${dash(p.mode)}</td><td>${dash(p.note)}</td>
          <td class="num"><button class="btn link sm" data-action="delete-payment" data-id="${p.id}">Remove</button></td></tr>`)}</tbody></table></div>`
        : h`<div class="empty">No payments yet.</div>`}
      <div class="muted small card-foot">Simple interest, counted daily on the principal left (30-day month). Each payment clears interest due first, then principal.</div>
    </div>
    ${documentsCard('loan', l.id, l.documents, ['Gold items photo', 'Pledge receipt', 'Weighing slip'])}`, 'loans');
}

async function pageSettings() {
  setTitle('Settings');
  const users = await api('/users');
  shell(h`
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="grid grid-2">
      <form class="card card-pad" id="pw-form"><h2 class="mb">Change your password</h2>
        <div class="form-error"></div>
        <div class="fields one-col">
          <div><label for="pw-cur">Current password</label><input id="pw-cur" name="current" type="password" autocomplete="current-password" required></div>
          <div><label for="pw-new">New password</label><input id="pw-new" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
        </div><div class="form-actions"><button class="btn primary">Update password</button></div></form>
      <div class="card card-pad"><h2 class="mb">Staff accounts</h2>
        <ul class="plain-list">${users.map((u) => h`<li>${u.username} <span class="muted small">since ${fmtDate(u.created_at)}</span></li>`)}</ul>
        <form id="user-form"><div class="form-error"></div>
          <div class="fields one-col">
            <div><label for="nu">New username</label><input id="nu" name="username" autocomplete="off" required></div>
            <div><label for="np">Password</label><input id="np" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
          </div><div class="form-actions"><button class="btn">Add account</button></div></form></div>
    </div>
    <div class="card card-pad mt"><h2>Backup</h2>
      <p class="muted">Download every customer, loan and payment as a JSON file. Keep it somewhere safe: it contains phone numbers and ID numbers.</p>
      <a class="btn" href="/api/export" download>Download backup</a></div>`, 'settings');

  const wire = (form, path, msg) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.textContent = '';
    try { await api(path, { method: 'POST', body: formData(form) }); toast(msg); route(); } catch (ex) { err.textContent = ex.message; }
  });
  wire($('#pw-form'), '/password', 'Password updated');
  wire($('#user-form'), '/users', 'Account added');
}

// ---------- dialogs ----------

function dialog(content, onSubmit) {
  const d = document.createElement('dialog');
  d.innerHTML = h`<form method="dialog" class="dlg-body">${content}
    <div class="form-error"></div>
    <div class="form-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></div></form>`.s;
  document.body.appendChild(d);
  const form = $('form', d);
  form.addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    try { await onSubmit(formData(form)); d.close(); } catch (ex) { $('.form-error', form).textContent = ex.message; }
  });
  d.addEventListener('close', () => d.remove());
  d.showModal();
  const first = $('input', d);
  if (first) first.focus();
}

function paymentDialog(loanId) {
  dialog(h`<h2>Record payment</h2><div class="fields">
      <div><label for="pd-amt">Amount (₹)</label><input id="pd-amt" name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" required></div>
      <div><label for="pd-date">Date</label><input id="pd-date" name="paid_on" type="date" value="${today()}" required></div>
      <div><label for="pd-mode">Mode</label><select id="pd-mode" name="mode">${options(PAY_MODES, 'Cash')}</select></div>
      <div><label for="pd-note">Note</label><input id="pd-note" name="note" maxlength="500"></div></div>`,
  async (body) => { await api(`/loans/${loanId}/payments`, { method: 'POST', body }); toast('Payment recorded'); route(); });
}

function closeDialog(loanId) {
  dialog(h`<h2>Close loan</h2><p class="muted">Interest stops on the closing date. Pledged items should be returned to the customer.</p>
      <div class="fields"><div><label for="cd-date">Closing date</label><input id="cd-date" name="closed_date" type="date" value="${today()}" required></div></div>`,
  async (body) => { await api(`/loans/${loanId}/close`, { method: 'POST', body }); toast('Loan closed'); route(); });
}

// ---------- global events ----------

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn) {
    const { action, id } = btn.dataset;
    try {
      if (action === 'logout') { await api('/logout', { method: 'POST' }); state.user = null; location.hash = '#/'; renderAuth(); }
      else if (action === 'reveal') {
        const span = btn.previousElementSibling;
        const showing = span.textContent === span.dataset.full;
        span.textContent = showing ? span.dataset.masked : span.dataset.full;
        btn.textContent = showing ? 'Show' : 'Hide';
      }
      else if (action === 'print') window.print();
      else if (action === 'delete-doc') {
        if (confirm('Remove this file?')) { await api(`/documents/${id}`, { method: 'DELETE' }); toast('File removed'); route(); }
      }
      else if (action === 'add-payment') paymentDialog(id);
      else if (action === 'close-loan') closeDialog(id);
      else if (action === 'reopen-loan') { await api(`/loans/${id}/reopen`, { method: 'POST' }); toast('Loan reopened'); route(); }
      else if (action === 'delete-payment') {
        if (confirm('Remove this payment?')) { await api(`/payments/${id}`, { method: 'DELETE' }); toast('Payment removed'); route(); }
      } else if (action === 'delete-loan') {
        if (confirm('Delete this loan and all its payments? This cannot be undone.')) { await api(`/loans/${id}`, { method: 'DELETE' }); toast('Loan deleted'); location.hash = '#/loans'; }
      } else if (action === 'delete-customer') {
        if (confirm('Delete this customer? This cannot be undone.')) { await api(`/customers/${id}`, { method: 'DELETE' }); toast('Customer deleted'); location.hash = '#/customers'; }
      }
    } catch (ex) { toast(ex.message, true); }
    return;
  }
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a, button')) location.hash = row.dataset.href;
});

// ---------- router ----------

async function route() {
  if (!state.user) return renderAuth();
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  try {
    if (!parts.length) await pageDashboard();
    else if (parts[0] === 'customers') {
      if (parts[1] === 'new') await pageCustomerEdit(null);
      else if (parts[1] && parts[2] === 'edit') await pageCustomerEdit(parts[1]);
      else if (parts[1]) await pageCustomer(parts[1]);
      else await pageCustomers(params);
    } else if (parts[0] === 'loans') {
      if (parts[1] === 'new') await pageLoanEdit(null, params);
      else if (parts[1] && parts[2] === 'edit') await pageLoanEdit(parts[1], params);
      else if (parts[1]) await pageLoan(parts[1]);
      else await pageLoans(params);
    } else if (parts[0] === 'settings') await pageSettings();
    else location.hash = '#/';
    window.scrollTo(0, 0);
  } catch (ex) {
    if (!state.user) return;
    shell(h`<div class="card empty">${ex.message}<br><br><a class="btn" href="#/">Back to dashboard</a></div>`);
  }
}

async function boot() {
  const s = await api('/status');
  state.user = s.user;
  state.setupNeeded = s.setupNeeded;
  state.setupCodeRequired = s.setupCodeRequired;
  route();
}

window.addEventListener('hashchange', route);
boot().catch((e) => { app.innerHTML = h`<p class="boot">Could not reach the server: ${e.message}</p>`.s; });
