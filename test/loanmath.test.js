'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeLoan } = require('../loanmath');

const loan = { principal: 10000, interest_rate: 2, start_date: '2026-01-01', status: 'active', due_date: '2026-12-31' };

test('accrues simple interest per 30-day month', () => {
  const r = computeLoan(loan, [], '2026-01-31'); // 30 days
  assert.strictEqual(r.interest_due, 200);
  assert.strictEqual(r.total_due, 10200);
  assert.strictEqual(r.overdue, false);
});

test('payments clear interest first, then principal', () => {
  const r = computeLoan(loan, [{ id: 1, paid_on: '2026-01-31', amount: 5200 }], '2026-01-31');
  assert.strictEqual(r.interest_paid, 200);
  assert.strictEqual(r.principal_paid, 5000);
  assert.strictEqual(r.outstanding_principal, 5000);
  assert.strictEqual(r.total_due, 5000);
});

test('interest after a part-payment accrues on the reduced principal', () => {
  const r = computeLoan(loan, [{ id: 1, paid_on: '2026-01-31', amount: 5200 }], '2026-03-02'); // +30 days
  assert.strictEqual(r.interest_due, 100);
});

test('closed loans stop accruing on the closed date', () => {
  const closed = { ...loan, status: 'closed', closed_date: '2026-01-31' };
  assert.strictEqual(computeLoan(closed, [], '2026-06-01').interest_due, 200);
});

test('overdue flag and overpayment', () => {
  const r = computeLoan({ ...loan, due_date: '2026-01-15' }, [{ id: 1, paid_on: '2026-01-31', amount: 10500 }], '2026-02-01');
  assert.strictEqual(r.overdue, true);
  assert.strictEqual(r.extra_paid, 300);
  assert.strictEqual(r.total_due, 0);
});
