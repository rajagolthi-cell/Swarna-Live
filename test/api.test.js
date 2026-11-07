import test from 'node:test';
import assert from 'node:assert';
import { createServer } from '../server.js';
import { sqliteDb, memoryFiles } from '../src/node-adapters.js';

async function start(t, opts = {}) {
  const files = memoryFiles();
  const server = createServer({ db: sqliteDb(':memory:'), files, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, method = 'GET', body, headers = {}) => {
    const isForm = body instanceof FormData;
    const res = await fetch(origin + '/api' + path, {
      method,
      headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), cookie, ...headers },
      body: isForm ? body : body && JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
  };
  return { call, files, origin };
}

test('end-to-end API flow', async (t) => {
  const { call } = await start(t);

  assert.strictEqual((await call('/status')).data.setupNeeded, true);
  assert.strictEqual((await call('/customers')).status, 401, 'data is locked before login');
  assert.strictEqual((await call('/setup', 'POST', { username: 'admin', password: 'short' })).status, 400);
  assert.strictEqual((await call('/setup', 'POST', { username: 'admin', password: 'goldsecret1' })).status, 200);
  assert.strictEqual((await call('/setup', 'POST', { username: 'x', password: 'goldsecret1' })).status, 403, 'setup runs only once');

  assert.strictEqual((await call('/customers', 'POST', { name: 'Ravi', phone: 'abc' })).status, 400);
  const c = await call('/customers', 'POST', { name: 'Ravi Kumar', phone: '98765 43210', id_type: 'Aadhaar Card', id_number: '123412341234' });
  assert.strictEqual(c.status, 201);

  const list = await call('/customers?q=9876');
  assert.strictEqual(list.data.length, 1);
  assert.strictEqual(list.data[0].id_number, undefined, 'full ID number is not sent in lists');
  assert.strictEqual(list.data[0].id_number_masked, '••••••••1234');

  const l = await call('/loans', 'POST', { customer_id: c.data.id, principal: 50000, interest_rate: 1.5, start_date: '2026-01-01', collateral_type: 'Gold', gold_weight_g: 12.5, gold_purity: '22K' });
  assert.strictEqual(l.status, 201);
  const loan = (await call(`/loans/${l.data.id}`)).data;
  assert.strictEqual(loan.loan_no, `SL-2026-${String(l.data.id).padStart(4, '0')}`);

  assert.strictEqual((await call(`/loans/${l.data.id}/payments`, 'POST', { paid_on: '2026-01-31', amount: 750 })).status, 201);
  assert.strictEqual((await call(`/loans/${l.data.id}`)).data.interest_paid, 750);
  assert.strictEqual((await call(`/customers/${c.data.id}`, 'DELETE')).status, 400, 'cannot delete customer with loans');

  const dash = (await call('/dashboard')).data;
  assert.strictEqual(dash.active_loans, 1);
  assert.strictEqual(dash.gold_weight_g, 12.5);

  assert.strictEqual((await call(`/loans/${l.data.id}/close`, 'POST', { closed_date: '2026-02-01' })).status, 200);
  assert.strictEqual((await call('/loans?status=closed')).data.length, 1);

  await call('/logout', 'POST');
  assert.strictEqual((await call('/loans')).status, 401);
  assert.strictEqual((await call('/login', 'POST', { username: 'admin', password: 'wrongpass' })).status, 401);
  assert.strictEqual((await call('/login', 'POST', { username: 'ADMIN', password: 'goldsecret1' })).status, 200);
});

test('setup code is required when configured', async (t) => {
  const { call } = await start(t, { setupCode: 'GOLD-1234' });
  assert.strictEqual((await call('/status')).data.setupCodeRequired, true);
  assert.strictEqual((await call('/setup', 'POST', { username: 'a', password: 'goldsecret1' })).status, 403);
  assert.strictEqual((await call('/setup', 'POST', { username: 'a', password: 'goldsecret1', setup_code: 'WRONG' })).status, 403);
  assert.strictEqual((await call('/setup', 'POST', { username: 'a', password: 'goldsecret1', setup_code: 'GOLD-1234' })).status, 200);
});

test('document upload, download and delete', async (t) => {
  const { call, files } = await start(t);
  await call('/setup', 'POST', { username: 'admin', password: 'goldsecret1' });
  const c = await call('/customers', 'POST', { name: 'Asha', phone: '9000000001' });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  const upload = (type, data = png) => {
    const fd = new FormData();
    fd.set('owner_type', 'customer');
    fd.set('owner_id', String(c.data.id));
    fd.set('label', 'Aadhaar front');
    fd.set('file', new Blob([data], { type }), 'aadhaar.png');
    return call('/documents', 'POST', fd);
  };
  assert.strictEqual((await upload('text/html')).status, 400, 'only images and PDFs');
  const up = await upload('image/png');
  assert.strictEqual(up.status, 201);
  assert.strictEqual(files.size(), 1);

  const docs = (await call(`/customers/${c.data.id}`)).data.documents;
  assert.strictEqual(docs.length, 1);
  assert.strictEqual(docs[0].label, 'Aadhaar front');

  const file = await call(`/documents/${up.data.id}/file`);
  assert.strictEqual(file.status, 200);
  assert.strictEqual(file.headers.get('content-type'), 'image/png');
  assert.deepStrictEqual([...file.data], [...png]);

  // deleting the customer removes their files from storage
  assert.strictEqual((await call(`/customers/${c.data.id}`, 'DELETE')).status, 200);
  assert.strictEqual(files.size(), 0);
  assert.strictEqual((await call(`/documents/${up.data.id}/file`)).status, 404);
});

test('cross-site POST is refused', async (t) => {
  const { call } = await start(t);
  const r = await call('/setup', 'POST', { username: 'a', password: 'goldsecret1' }, { origin: 'https://evil.example' });
  assert.strictEqual(r.status, 403);
});
