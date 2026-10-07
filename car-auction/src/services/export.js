import ExcelJS from 'exceljs';
import { Worker } from 'node:worker_threads';
import { costReport, costLines } from './costs.js';
import { STATUS_LABEL } from '../domain/status.js';

const STAGES = [
  ['purchase_lyd', 'الشراء والرسوم'],
  ['us_logistics_lyd', 'لوجستيات أمريكا'],
  ['ocean_lyd', 'الشحن البحري'],
  ['libya_port_lyd', 'الميناء الليبي'],
  ['customs_lyd', 'الجمارك'],
  ['libya_inland_lyd', 'النقل الداخلي'],
  ['preparation_lyd', 'التجهيز'],
  ['overhead_lyd', 'أخرى'],
];
const LYD_FMT = '#,##0.000';

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 32;
}

/**
 * ملف Excel حقيقي (.xlsx) بثلاث أوراق: ملخص، تكلفة كل سيارة، وكل البنود التفصيلية.
 * جلب البيانات غير متزامن هنا، أما بناء الملف (عمل معالج ثقيل) فيجري في Worker thread
 * منفصل حتى لا يُجمِّد حلقة الأحداث فتتأخر المزايدات الحية أثناء تصدير كبير.
 */
export async function costReportXlsx(filters, user) {
  const report = await costReport(filters);
  const lines = await costLines(report.rows.map((r) => r.vehicle_id));
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./xlsx-worker.js', import.meta.url), {
      workerData: { report, lines, user: { full_name: user.full_name }, filters },
    });
    w.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(Buffer.from(m.buffer))));
    w.once('error', reject);
  });
}

/** بناء الملف (دالة نقية تُستدعى داخل الـ Worker) */
export async function buildCostWorkbook({ report, lines, user, filters }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = user.full_name;
  wb.created = new Date();
  wb.title = 'تقرير تكاليف السيارات';

  // 1) الملخص
  const s = wb.addWorksheet('الملخص', { views: [{ rightToLeft: true }] });
  s.columns = [{ width: 34 }, { width: 22 }];
  s.addRow(['تقرير تكاليف السيارات المستوردة']).font = { bold: true, size: 16 };
  s.addRow([`تاريخ الإصدار: ${new Date().toLocaleString('en-GB')}`]);
  s.addRow([`أصدره: ${user.full_name}`]);
  s.addRow([`المرشحات: ${Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('، ') || 'بلا'}`]);
  s.addRow([]);
  styleHeader(s.addRow(['البند', 'القيمة (د.ل)']));
  const t = report.totals;
  const summaryRows = [
    ['عدد السيارات', t.vehicles],
    ['عدد المباعة', t.sold],
    ...STAGES.map(([k, label]) => [`إجمالي ${label}`, Number(t[k])]),
    ['إجمالي التكلفة الواصلة', Number(t.total_cost_lyd)],
    ['منها غير مسدد للموردين', Number(t.unpaid_lyd)],
    ['إجمالي المبيعات', Number(t.sale_price_lyd)],
    ['إجمالي هامش الربح (المباعة)', Number(t.margin_lyd)],
    ['متوسط نسبة الربح على التكلفة %', t.avg_margin_pct == null ? '—' : Number(t.avg_margin_pct)],
  ];
  for (const r of summaryRows) {
    const row = s.addRow(r);
    if (typeof r[1] === 'number' && !['عدد السيارات', 'عدد المباعة'].includes(r[0]) && !r[0].includes('%')) row.getCell(2).numFmt = LYD_FMT;
  }

  // 2) تكلفة كل سيارة
  const v = wb.addWorksheet('تكلفة كل سيارة', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1, xSplit: 2 }] });
  v.columns = [
    { header: 'رقم المخزون', key: 'stock_no', width: 15 },
    { header: 'VIN', key: 'vin', width: 21 },
    { header: 'السيارة', key: 'car', width: 26 },
    { header: 'الحالة', key: 'status', width: 18 },
    { header: 'المصدر/اللوت', key: 'src', width: 18 },
    { header: 'الحاوية', key: 'container', width: 15 },
    ...STAGES.map(([k, label]) => ({ header: label, key: k, width: 15, style: { numFmt: LYD_FMT } })),
    { header: 'إجمالي التكلفة', key: 'total_cost_lyd', width: 17, style: { numFmt: LYD_FMT } },
    { header: 'غير مسدد', key: 'unpaid_lyd', width: 14, style: { numFmt: LYD_FMT } },
    { header: 'سعر البيع', key: 'sale_price_lyd', width: 15, style: { numFmt: LYD_FMT } },
    { header: 'الهامش', key: 'margin_lyd', width: 15, style: { numFmt: LYD_FMT } },
  ];
  styleHeader(v.getRow(1));
  for (const r of report.rows) {
    const row = v.addRow({
      stock_no: r.stock_no, vin: r.vin, car: `${r.year} ${r.make} ${r.model}`, status: STATUS_LABEL[r.status],
      src: r.source ? `${r.source} ${r.lot_number}` : '—', container: r.container_no || '—',
      ...Object.fromEntries(STAGES.map(([k]) => [k, Number(r[k])])),
      total_cost_lyd: Number(r.total_cost_lyd), unpaid_lyd: Number(r.unpaid_lyd),
      sale_price_lyd: r.sale_price_lyd == null ? null : Number(r.sale_price_lyd),
      margin_lyd: r.margin_lyd == null ? null : Number(r.margin_lyd),
    });
    if (r.margin_lyd != null) row.getCell('margin_lyd').font = { color: { argb: Number(r.margin_lyd) >= 0 ? 'FF047857' : 'FFB91C1C' }, bold: true };
  }
  // صف الإجماليات بمعادلات Excel حقيقية (يتحدث إن عدّل المحاسب أي خلية)
  const last = report.rows.length + 1;
  const totalRow = v.addRow({ stock_no: 'الإجمالي' });
  totalRow.font = { bold: true };
  totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  for (const key of [...STAGES.map(([k]) => k), 'total_cost_lyd', 'unpaid_lyd', 'sale_price_lyd', 'margin_lyd']) {
    const col = v.getColumn(key).letter;
    totalRow.getCell(key).value = { formula: `SUM(${col}2:${col}${last})` };
  }
  v.autoFilter = { from: 'A1', to: { row: 1, column: v.columnCount } };

  // 3) البنود التفصيلية
  const d = wb.addWorksheet('البنود التفصيلية', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  d.columns = [
    { header: 'رقم المخزون', key: 'stock_no', width: 15 },
    { header: 'البند', key: 'category', width: 28 },
    { header: 'الوصف', key: 'description', width: 36 },
    { header: 'المورد', key: 'vendor', width: 22 },
    { header: 'المبلغ', key: 'amount', width: 13, style: { numFmt: '#,##0.000' } },
    { header: 'العملة', key: 'currency', width: 8 },
    { header: 'سعر الصرف', key: 'fx_rate_to_lyd', width: 11, style: { numFmt: '0.0000' } },
    { header: 'بالدينار', key: 'amount_lyd', width: 14, style: { numFmt: LYD_FMT } },
    { header: 'الحالة', key: 'status', width: 10 },
    { header: 'التاريخ', key: 'incurred_at', width: 12 },
    { header: 'رقم الفاتورة', key: 'invoice_ref', width: 16 },
    { header: 'مسدد', key: 'is_paid', width: 8 },
  ];
  styleHeader(d.getRow(1));
  for (const l of lines) {
    d.addRow({
      ...l, amount: Number(l.amount), fx_rate_to_lyd: Number(l.fx_rate_to_lyd), amount_lyd: Number(l.amount_lyd),
      status: l.status === 'ACTUAL' ? 'فعلي' : 'تقديري', incurred_at: new Date(l.incurred_at), is_paid: l.is_paid ? 'نعم' : 'لا',
    });
  }
  d.getColumn('incurred_at').numFmt = 'yyyy-mm-dd';
  d.autoFilter = { from: 'A1', to: { row: 1, column: d.columnCount } };

  return wb.xlsx.writeBuffer();
}

/** CSV بترميز UTF-8 مع BOM (يفتح بالعربية صحيحًا في Excel) */
export async function costReportCsv(filters) {
  const report = await costReport(filters);
  const head = ['stock_no', 'vin', 'year', 'make', 'model', 'status', ...STAGES.map(([k]) => k), 'total_cost_lyd', 'sale_price_lyd', 'margin_lyd'];
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; // منع حقن الصيغ
  };
  return '﻿' + [head.join(','), ...report.rows.map((r) => head.map((h) => q(r[h])).join(','))].join('\n');
}
