// End-to-end browser check against a running local Swarna Live (`npm run dev`).
// Uses Playwright (install it separately: `npm i -D playwright && npx playwright install chromium`).
// Usage: BASE_URL=http://localhost:8787 SETUP_TOKEN=... OUT=./ui-shots node scripts/ui-check.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { chromium, devices } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const OUT = process.env.OUT || 'ui-shots';
const SETUP = process.env.SETUP_TOKEN || 'local-setup-code-2026';
fs.mkdirSync(OUT, { recursive: true });
const shot = (page, name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, ...opts });
const log = (...a) => console.log('✔', ...a);
const errors = [];

const browser = await chromium.launch();

// A realistic test photo: "jewellery" + "scale display" drawn on a canvas, saved as PNG.
const maker = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await maker.setContent(`<body style="margin:0"><div style="width:1200px;height:900px;background:#d9d4c7;display:grid;place-items:center;font-family:sans-serif">
  <div style="width:520px;height:340px;background:#2b2b2b;border-radius:24px;display:grid;place-items:center;position:relative">
    <div style="position:absolute;top:-150px;width:260px;height:260px;border-radius:50%;border:26px solid #e2b33c;box-shadow:0 0 30px #f6d77a"></div>
    <div style="margin-top:120px;background:#9fd3a4;color:#132;padding:14px 26px;font:700 64px monospace;border-radius:8px">10.500 g</div>
  </div></div></body>`);
const photoPath = `${OUT}/test-photo.png`;
await maker.screenshot({ path: photoPath });
await maker.close();

const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await ctx.newPage();
process.on('unhandledRejection', async (e) => { try { await page.screenshot({ path: `${OUT}/FAILURE.png`, fullPage: true }); } catch {} console.error(e); process.exit(1); });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

// 1. first-owner setup (direct load of / must redirect to /setup)
await page.goto(BASE + '/');
await page.waitForURL('**/setup');
await shot(page, '01-setup');
await page.getByLabel('Setup code').fill(SETUP);
await page.getByLabel('Business name').fill('Sri Lakshmi Jewellers');
await page.getByLabel('Your name').fill('Lakshmi');
await page.getByLabel('Business email (used to sign in)').fill('owner@example.com');
await page.getByLabel('Password', { exact: true }).fill('gold-and-silver-123');
await page.getByLabel('Repeat password').fill('gold-and-silver-123');
await page.getByLabel('Your 6-digit PIN').fill('482915');
await page.getByLabel('Repeat PIN').fill('482915');
await page.getByRole('button', { name: 'Create owner account' }).click();
await page.getByText('Save these recovery codes now').waitFor();
await shot(page, '02-recovery-codes');
const codes = await page.locator('.codes code').allTextContents();
if (codes.length !== 10) throw new Error('expected 10 recovery codes');
await page.getByLabel('I have saved these codes somewhere safe').check();
await page.getByRole('button', { name: 'Continue' }).click();
await page.waitForURL('**/settings/rates');
await page.getByRole('link', { name: 'Business', exact: true }).click();
log('first-owner setup, recovery codes shown once');

// 2. business details + rates
await page.getByLabel('Phone', { exact: false }).first().fill('+91 98480 00000');
await page.getByLabel('Address').fill('12-4-56 Main Road, Vijayawada');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.getByText('Business details saved').waitFor();
await page.getByRole('link', { name: 'Rates' }).click();
await page.getByLabel('24K gold — price per gram (₹)').fill('7200');
await page.getByRole('button', { name: 'Save gold rate' }).click();
await page.getByText('Gold rate saved').waitFor();
await page.getByLabel('999 silver — price per gram (₹)').fill('95');
await page.getByRole('button', { name: 'Save silver rate' }).click();
await page.getByText('Silver rate saved').waitFor();
await shot(page, '03-rates');
log('business-entered rates saved with history');

// 3. add an employee
await page.getByRole('link', { name: 'Employees' }).first().click();
await page.getByRole('button', { name: '+ Add staff' }).click();
await page.getByLabel('Name').fill('Arjun');
await page.getByLabel('Temporary 6-digit PIN').fill('730146');
await page.getByRole('button', { name: 'Save' }).click();
await page.getByText('Arjun added').waitFor();
await shot(page, '04-employees');
log('employee added');

// 4. new buyback with camera photo, then a rate change during preparation
await page.getByRole('link', { name: 'New Buyback' }).first().click();
await page.getByLabel('Customer name').fill('Ravi Kumar');
await page.getByLabel('Phone number').fill('98480 12345');
await page.getByLabel('Item type').selectOption('Chain');
await page.getByLabel('Item description').fill('Chain with pendant');
await page.getByLabel('Gross weight (g)').fill('10.500');
await page.getByLabel('Stone / other deduction (g)').fill('0.500');
await page.locator('input[capture="environment"]').setInputFiles(photoPath);
await page.locator('.photo-preview img').waitFor();
const offerText = await page.locator('.summary-card .offer strong').textContent();
if (!offerText.includes('39,600.00')) throw new Error(`unexpected offer ${offerText}`);
await shot(page, '05-new-buyback');
// someone changes the gold rate in the meantime
await page.evaluate(async () => {
  const me = await (await fetch('/api/auth/me')).json();
  await fetch('/api/rates', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ metal: 'gold', rate: '7400' }) });
});
await page.getByRole('button', { name: 'Save estimate' }).click();
await page.getByRole('dialog', { name: 'Please review the updated offer' }).waitFor();
await shot(page, '06-rate-changed-review');
await page.getByRole('button', { name: 'Save with updated offer' }).click();
await page.waitForURL(/\/transactions\/[0-9a-f-]{36}$/);
await page.getByText('Estimate saved with its photograph').waitFor();
await page.locator('.photo-frame img').evaluate((img) => img.complete || new Promise((r) => { img.onload = r; }));
await shot(page, '07-transaction-detail');
const savedOffer = await page.locator('.offer strong').textContent();
if (!savedOffer.includes('40,699.98')) throw new Error(`expected reviewed offer, got ${savedOffer}`);
log('rate change required review; saved with reviewed offer', savedOffer);

// 5. status change, receipt (screen + print), direct navigation / refresh
await page.getByRole('button', { name: 'Change status' }).click();
await page.getByLabel('Reason').fill('Customer agreed to estimate');
await page.getByRole('button', { name: 'Save' }).click();
await page.locator('.badge-accepted').first().waitFor();
const detailUrl = page.url();
await page.reload();
await page.locator('h1', { hasText: 'Order' }).waitFor();
log('direct reload of a transaction page works');
await page.getByRole('link', { name: 'Print receipt' }).click();
await page.locator('.receipt').waitFor();
await shot(page, '08-receipt');
await page.emulateMedia({ media: 'print' });
await shot(page, '09-receipt-print');
if (await page.locator('.receipt-tools').isVisible()) throw new Error('print layout shows controls');
await page.emulateMedia({ media: 'screen' });
log('receipt print layout has no navigation');

// 6. transactions list + CSV export
await page.goto(BASE + '/transactions');
await page.locator('.table tbody tr').first().waitFor();
await shot(page, '10-transactions');
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV' }).click()]);
const csv = fs.readFileSync(await download.path(), 'utf8');
if (!csv.includes('Ravi Kumar') || !csv.includes("'+919848012345")) throw new Error('CSV export content unexpected');
log('CSV export downloaded');

// 7. backups section (Google not configured locally) + dashboard
await page.goto(BASE + '/settings/backups');
await page.getByText('Google Drive and Sheets backup').waitFor();
await shot(page, '11-backups');
await page.goto(BASE + '/');
await page.getByText('Total quotes').waitFor();
await shot(page, '12-owner-dashboard');

// 8. switch profile → employee with temporary PIN → must set new PIN → employee dashboard
await page.goto(BASE + '/settings/account');
await page.getByRole('button', { name: 'Switch profile' }).first().click();
await page.waitForURL('**/profiles');
await shot(page, '13-profiles');
await page.getByRole('button', { name: /Arjun/ }).click();
await page.getByLabel('6-digit PIN').fill('730146');
await page.getByRole('button', { name: 'Unlock' }).click();
await page.waitForURL('**/change-pin');
await page.getByLabel('New 6-digit PIN').fill('918273');
await page.getByLabel('Repeat new PIN').fill('918273');
await page.getByRole('button', { name: 'Save PIN' }).click();
await page.waitForURL(BASE + '/');
if (await page.getByText('Total quotes').count()) throw new Error('employee can see owner metrics');
if (await page.getByRole('link', { name: 'Employees' }).count()) throw new Error('employee sees Employees');
await shot(page, '14-employee-dashboard');
const forbidden = await page.evaluate(async () => (await fetch('/api/staff')).status);
if (forbidden !== 403) throw new Error('employee reached owner API');
log('employee view hides owner-only sections; server refuses owner APIs');

// 9. phone and iPad layouts
for (const [name, device] of [['phone', devices['iPhone 13']], ['ipad', devices['iPad Pro 11']]]) {
  const c = await browser.newContext({ ...device });
  await c.addCookies(await ctx.cookies());
  const p = await c.newPage();
  await p.goto(BASE + '/buyback/new');
  await p.getByLabel('Customer name').waitFor();
  await shot(p, `15-${name}-new-buyback`);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`${name}: horizontal scroll ${overflow}px`);
  await p.goto(BASE + '/transactions');
  await p.locator('.table tbody tr, .empty').first().waitFor();
  await shot(p, `16-${name}-transactions`, { fullPage: false });
  await c.close();
}
log('phone and iPad layouts have no horizontal scrolling');

// 10. logout
await page.goto(BASE + '/settings/account');
await page.getByRole('button', { name: 'Log out of business account' }).click();
await page.waitForURL('**/login');
log('logout ends the business session');

await browser.close();
if (errors.length) { console.error('Browser errors:', errors); process.exit(1); }
console.log('UI check passed. Screenshots in', OUT);
