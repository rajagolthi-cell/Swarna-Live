'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');

test('end-to-end API flow', async (t) => {
  const app = createApp({ dbFile: ':memory:' });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };

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
