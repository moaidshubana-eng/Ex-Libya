// يولّد نماذج حقيقية من تقرير التكاليف: Excel وCSV من الواجهة البرمجية، وPDF من صفحة التقرير بتنسيق الطباعة
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const OUT = new URL('../docs/samples/', import.meta.url);
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'ar-LY', viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE);
await page.fill('input[name=email]', 'accountant@auction.ly');
await page.fill('input[name=password]', 'Demo@2026pass');
await page.click('form[data-login] button.btn-primary');
await page.waitForSelector('.kpi');
for (const [path, file] of [['/api/reports/costs.xlsx', 'cost-report.xlsx'], ['/api/reports/costs.csv', 'cost-report.csv']]) {
  const r = await page.request.get(BASE + path);
  writeFileSync(new URL(file, OUT), await r.body());
  console.log('saved', file);
}
await page.goto(`${BASE}/#/reports`);
await page.waitForSelector('table.t');
await page.emulateMedia({ media: 'print' });
await page.pdf({ path: new URL('cost-report.pdf', OUT).pathname, format: 'A4', landscape: true, printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
console.log('saved cost-report.pdf');
await browser.close();
