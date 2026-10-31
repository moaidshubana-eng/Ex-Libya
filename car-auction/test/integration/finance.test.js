import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

resetDb();
const { query } = await import('../../src/db.js');
const { server, base } = await startApp();
after(() => stopApp(server));
const one = async (sql, p) => (await query(sql, p)).rows[0];
const asRole = async (email) => { const c = client(base); assert.equal((await c.login(email)).status, 200); return c; };
const month = new Date().toISOString().slice(0, 7);
const today = new Date().toISOString().slice(0, 10);

let acc, sales, ops, viewer, cust, vendor, car;
before(async () => {
  [acc, sales, ops, viewer] = await Promise.all(['accountant', 'sales', 'ops', 'viewer'].map((r) => asRole(`${r}@auction.ly`)));
  await query(`DELETE FROM exchange_rates WHERE currency = 'USD' AND effective_date = current_date`);
  await query(`INSERT INTO exchange_rates (currency, rate_to_lyd, effective_date, source) VALUES ('USD', 7, current_date, 'MANUAL')`);
  cust = (await sales.post('/api/customers', { fullName: 'عميل الإيصالات', phone: '0915550001' })).data.id;
  vendor = (await acc.post('/api/vendors', { name: 'مورد الإيصالات', vendorType: 'OTHER' })).data.id;
  car = (await one(`SELECT id FROM vehicles WHERE status = 'IN_STOCK' AND customer_id IS NULL ORDER BY stock_no LIMIT 1`)).id;
  assert.equal((await sales.put(`/api/vehicles/${car}/deal`, { customerId: cust, customerPrice: '10000', customerCurrency: 'USD', vendorId: vendor })).status, 200);
});

describe('إيصال القبض وسند الصرف', () => {
  let p1, p2;
  test('أرقام مسلسلة RC للعميل و PV للمورد، والإيصال يبيّن الرصيد بعد الدفعة', async () => {
    p1 = (await acc.post(`/api/accounts/customers/${cust}/payments`, { amount: '4000', currency: 'USD', method: 'CASH', vehicleId: car })).data;
    p2 = (await acc.post(`/api/accounts/customers/${cust}/payments`, { amount: '7000', currency: 'LYD', settleCurrency: 'USD', method: 'CASH' })).data;
    const y = new Date().getFullYear();
    assert.match(p1.receipt_no, new RegExp(`^RC-${y}-\\d{5}$`));
    assert.equal(Number(p2.receipt_no.slice(-5)), Number(p1.receipt_no.slice(-5)) + 1);
    const pv = (await acc.post(`/api/accounts/vendors/${vendor}/payments`, { amount: '100', currency: 'USD', method: 'CASH' })).data;
    assert.match(pv.receipt_no, /^PV-/);
    const r1 = (await sales.get(`/api/account-payments/${p1.id}/receipt`)).data;
    assert.equal(r1.payment.receiptNo, p1.receipt_no);
    assert.deepEqual(r1.balancesAfter, [{ currency: 'USD', balance: '6000.000' }]);
    const r2 = (await acc.get(`/api/account-payments/${p2.id}/receipt`)).data;
    assert.deepEqual(r2.balancesAfter, [{ currency: 'USD', balance: '5000.000' }]);
    assert.equal(r2.payment.settleAmount, '1000.000');
    assert.equal(r1.vehicle.id, car);
  });
  test('صلاحيات الإيصال تتبع صلاحية الحساب', async () => {
    assert.equal((await ops.get(`/api/account-payments/${p1.id}/receipt`)).status, 403);
    const pv = await one(`SELECT id FROM account_payments WHERE vendor_id = $1`, [vendor]);
    assert.equal((await ops.get(`/api/account-payments/${pv.id}/receipt`)).status, 200);
    assert.equal((await sales.get(`/api/account-payments/${pv.id}/receipt`)).status, 403);
  });
});

describe('لنا وعلينا', () => {
  test('مجموع المستحق لكل عملة وأكبر الأرصدة، وكل دور يرى جانبه', async () => {
    const o = (await acc.get('/api/accounts/overview')).data;
    assert.ok(o.customers && o.vendors);
    assert.ok(o.customers.top.some((t) => t.id === cust));
    assert.ok(Number(o.customers.owed.find((x) => x.currency === 'USD').amount) >= 5000);
    const s = (await sales.get('/api/accounts/overview')).data;
    assert.ok(s.customers && !s.vendors);
    const p = (await ops.get('/api/accounts/overview')).data;
    assert.ok(p.vendors && !p.customers);
  });
});

describe('المصاريف العامة والربح الشهري', () => {
  let exp;
  test('إضافة مصروف بالدينار وبالدولار (سعر اليوم)، والصلاحيات', async () => {
    let r = await acc.post('/api/expenses', { category: 'RENT', description: 'إيجار المعرض', amount: '3000', currency: 'LYD', expenseDate: today });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.expense_no, /^EX-\d{4}-\d{5}$/);
    exp = r.data;
    r = await acc.post('/api/expenses', { category: 'MARKETING', description: 'إعلان', amount: '100', currency: 'USD' });
    assert.equal(r.data.amount_lyd, '700.000');
    assert.equal((await sales.post('/api/expenses', { category: 'OTHER', description: 'x', amount: '1', currency: 'LYD' })).status, 403);
    assert.equal((await viewer.get(`/api/expenses?month=${month}`)).status, 200);
    assert.equal((await sales.get('/api/reports/profit')).status, 403);
  });
  test('الربح: سيارة العميل المسلَّمة بسعرها × سعر الصرف − تكلفتها − المصاريف', async () => {
    assert.equal((await ops.post(`/api/vehicles/${car}/status`, { to: 'SOLD' })).status, 200);
    const cost = Number((await one('SELECT total_cost_lyd FROM v_vehicle_landed_cost WHERE vehicle_id = $1', [car])).total_cost_lyd);
    const p = (await acc.get(`/api/reports/profit?month=${month}`)).data;
    const row = p.cars.find((c) => c.vehicleId === car);
    assert.equal(row.kind, 'طلب عميل');
    assert.equal(Number(row.revenueLyd), 70000);
    assert.equal(Number(row.profitLyd).toFixed(3), (70000 - cost).toFixed(3));
    assert.equal(Number(p.totals.expensesLyd), 3700);
    const t = p.totals;
    assert.equal((Number(t.revenueLyd) - Number(t.costLyd) - Number(t.expensesLyd)).toFixed(3), Number(t.netProfitLyd).toFixed(3));
  });
  test('إلغاء المصروف يخرجه من الربح ويبقى في القائمة', async () => {
    assert.equal((await acc.post(`/api/expenses/${exp.id}/void`, { reason: 'مكرر' })).status, 200);
    assert.equal(Number((await acc.get(`/api/reports/profit?month=${month}`)).data.totals.expensesLyd), 700);
    const l = (await acc.get(`/api/expenses?month=${month}`)).data;
    assert.ok(l.items.find((e) => e.id === exp.id).voided_at);
    assert.equal((await acc.get('/api/reports/profit?month=2026-13')).status, 422);
  });
});

describe('الهجرة 0003 على قاعدة قائمة', () => {
  test('تُرقّم الدفعات الموجودة بلا أرقام', async () => {
    await query('DROP TABLE IF EXISTS company_expenses');
    await query('DROP INDEX IF EXISTS uq_account_payments_receipt');
    await query('ALTER TABLE account_payments DROP COLUMN receipt_no');
    await query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await query(`INSERT INTO schema_migrations (name) VALUES ('0001_vehicle_image_content.sql'), ('0002_customer_vendor_accounts.sql') ON CONFLICT DO NOTHING`);
    await query(`DELETE FROM schema_migrations WHERE name = '0003_receipts_expenses.sql'`);
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const out = execFileSync('node', ['scripts/init-db.js'], { cwd: root, env: process.env, encoding: 'utf8' });
    assert.match(out, /0003_receipts_expenses/);
    assert.equal((await one('SELECT count(*)::int AS n FROM account_payments WHERE receipt_no IS NULL')).n, 0);
    assert.equal((await one(`SELECT to_regclass('auction.company_expenses') AS t`)).t, 'company_expenses');
  });
});
