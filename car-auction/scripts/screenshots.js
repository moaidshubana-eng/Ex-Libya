// يلتقط لقطات الشاشات الرئيسية (سطح المكتب + الجوال) إلى docs/ui/ — يتطلب خادمًا يعمل على BASE_URL
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const OUT = new URL('../docs/ui/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
async function session(email, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1.5, locale: 'ar-LY', colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  await page.goto(BASE);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', 'Demo@2026pass');
  await page.click('form[data-login] button.btn-primary');
  await page.waitForSelector('[data-content]');
  return { ctx, page };
}
async function shot(page, hash, name, { wait = '[data-content] > *:not(.skeleton)', full = false, before } = {}) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.goto(`${BASE}/${hash}`);
  await page.waitForSelector(wait, { timeout: 15000 });
  await page.waitForTimeout(700);
  if (before) await before(page);
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: full });
  console.log('saved', name);
}

// شاشة الدخول
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForSelector('form[data-login]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}01-login.png` });
  await ctx.close();
}

const { page } = await session('admin@auction.ly', { width: 1440, height: 900 });
await shot(page, '#/dashboard', '02-dashboard', { wait: '.kpi', full: true });
await shot(page, '#/vehicles', '03-vehicles-grid', { wait: '.vcard', full: false });
await shot(page, '#/vehicles?status=IN_TRANSIT_SEA,AT_PORT_LIBYA,IN_CUSTOMS&view=table', '04-vehicles-table', { wait: 'table.t' });
const vid = await page.evaluate(async () => (await (await fetch('/api/vehicles?status=IN_STOCK&pageSize=1')).json()).items[0].id);
await shot(page, `#/vehicles/${vid}`, '05-vehicle-detail', { wait: '.gallery', full: true });
await shot(page, `#/vehicles/${vid}`, '06-vehicle-zoom-lens', { wait: '.gallery', before: async (p) => {
  const b = await p.locator('.stage-img').boundingBox();
  await p.mouse.move(b.x + b.width * 0.62, b.y + b.height * 0.66);
  await p.waitForTimeout(300);
} });
await shot(page, `#/vehicles/${vid}`, '07-lightbox', { wait: '.gallery', before: async (p) => {
  await p.click('.stage-img img');
  await p.waitForSelector('.lightbox');
  await p.click('[data-act="in"]'); await p.click('[data-act="in"]');
  await p.waitForTimeout(300);
} });
await shot(page, `#/vehicles/${vid}`, '08-vehicle-costs', { wait: '.gallery', full: true, before: async (p) => { await p.click('[data-tab="costs"]'); await p.waitForTimeout(300); } });
const ids = await page.evaluate(async () => (await (await fetch('/api/vehicles?status=IN_STOCK,IN_AUCTION&pageSize=3')).json()).items.map((v) => v.id).join(','));
await shot(page, `#/compare?ids=${ids}`, '09-compare', { wait: '.compare', full: true });
await shot(page, '#/auctions', '10-auctions', { wait: '.lot-card' });
await shot(page, '#/shipments', '12-shipments', { wait: '.ship', full: false });
await shot(page, '#/customs', '13-customs-board', { wait: '.kanban' });
await shot(page, '#/reports', '14-cost-report', { wait: 'table.t' });
await shot(page, '#/integrations', '15-integrations', { wait: '.card', full: true });

const b = await session('bidder1@auction.ly', { width: 1440, height: 900 });
const lot = await b.page.evaluate(async () => {
  const d = await (await fetch('/api/auctions')).json();
  return d.events.flatMap((e) => e.lots).filter((l) => l.status === 'OPEN' && l.bid_count > 0)[1].id;
});
await shot(b.page, `#/lots/${lot}`, '11-live-bidding', { wait: '.bid-panel .big' });

const m = await session('admin@auction.ly', { width: 390, height: 844 });
await shot(m.page, '#/dashboard', '16-mobile-dashboard', { wait: '.kpi' });
await shot(m.page, `#/vehicles/${vid}`, '17-mobile-vehicle', { wait: '.gallery' });
const mb = await session('bidder2@auction.ly', { width: 390, height: 844 });
await shot(mb.page, `#/lots/${lot}`, '18-mobile-bidding', { wait: '.bid-panel .big', full: true });

const d = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });
const dp = await d.newPage();
await dp.goto(BASE);
await dp.fill('input[name=email]', 'accountant@auction.ly');
await dp.fill('input[name=password]', 'Demo@2026pass');
await dp.click('form[data-login] button.btn-primary');
await dp.waitForSelector('.kpi');
await shot(dp, '#/reports', '19-dark-mode-report', { wait: 'table.t' });

await browser.close();
