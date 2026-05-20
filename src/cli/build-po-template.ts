#!/usr/bin/env tsx
// ============================================================================
// build-po-template.ts
// Generates docs/samples/po-workbook-template.xlsx — the standardised PO
// workbook operators fill in for `import-purchase-orders --workbook`.
//
//   npm run build-po-template
//   npm run build-po-template -- --out /some/path.xlsx
//
// Re-run to regenerate the template after a column change. The supplier
// reference list is pulled live from brain.supplier_master (best-effort — the
// template still generates if the database is unreachable).
// ============================================================================

import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { getPgClient } from '../lib/supabase.js';

const STATUSES = ['draft', 'placed', 'confirmed', 'in_production', 'shipped',
  'at_destination', 'received', 'closed', 'cancelled'];
const PAYMENT_STATUSES = ['unpaid', 'deposit_paid', 'paid_in_full', 'not_applicable'];
const LINE_TYPES = ['product', 'packaging'];

// PO Info tab — [field, hint]. The field name (col A) must match the column
// the importer's parseHeaderRow looks up.
const PO_INFO: [string, string][] = [
  ['po_number', 'Unique PO number, e.g. PO22380'],
  ['supplier_id', 'A SUP-id or the exact supplier name (see the Instructions tab)'],
  ['status', STATUSES.join(' / ')],
  ['currency', 'Payment currency, e.g. GBP / USD / EUR'],
  ['order_date', 'YYYY-MM-DD — date placed with the supplier; leave blank while draft'],
  ['expected_ship_date', 'YYYY-MM-DD (optional)'],
  ['actual_ship_date', 'YYYY-MM-DD (optional)'],
  ['expected_arrival_date', 'YYYY-MM-DD (optional)'],
  ['actual_arrival_date', 'YYYY-MM-DD (optional)'],
  ['payment_terms', 'Free text, e.g. "15% deposit / 85% balance" (optional)'],
  ['total_value', 'Number — advisory PO total in the payment currency (optional)'],
  ['deposit_amount', 'Number (optional)'],
  ['balance_amount', 'Number (optional)'],
  ['payment_status', PAYMENT_STATUSES.join(' / ')],
  ['notes', 'Free text (optional)'],
];

// Lines tab — column headers (one row per SKU).
const LINE_HEADERS = [
  'ean', 'asin', 'supplier_sku', 'description', 'line_type',
  'qty_uk_3pl', 'qty_fba_uk', 'qty_usa_awd', 'qty_rw_held',
  'comp_fob', 'comp_lcl', 'comp_import_duty', 'import_duty_rate', 'comp_qa',
  'comp_china_3pl', 'comp_freight_dock', 'comp_photos', 'comp_bond_fee',
  'comp_amz_location_fee', 'comp_azus_storage', 'landed_cost_currency',
  'stated_landed_cost', 'packages_for', 'notes',
];

// An exceljs "pick from this list" cell validation.
function listDV(values: string[]) {
  return {
    type: 'list' as const,
    allowBlank: true,
    formulae: [`"${values.join(',')}"`],
  };
}

async function loadSuppliers(): Promise<string[]> {
  try {
    const pg = await getPgClient();
    try {
      const { rows } = await pg.query<{ supplier_id: string; name: string }>(
        'SELECT supplier_id, name FROM brain.supplier_master ORDER BY supplier_id',
      );
      return rows.map(r => `${r.supplier_id}  —  ${r.name}`);
    } finally {
      await pg.end();
    }
  } catch {
    return ['(supplier list unavailable — query brain.supplier_master for SUP-ids)'];
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const here = dirname(fileURLToPath(import.meta.url));
  const out = values.out
    ?? join(here, '..', '..', 'docs', 'samples', 'po-workbook-template.xlsx');

  const suppliers = await loadSuppliers();
  const wb = new ExcelJS.Workbook();

  // --- PO Info ---
  const info = wb.addWorksheet('PO Info');
  info.columns = [
    { header: 'Field', width: 24 },
    { header: 'Value', width: 40 },
    { header: 'Notes', width: 74 },
  ];
  for (const [field, hint] of PO_INFO) info.addRow([field, '', hint]);
  info.getRow(1).font = { bold: true };
  info.getColumn(1).font = { bold: true };
  const statusRow = 2 + PO_INFO.findIndex(([f]) => f === 'status');
  const payRow = 2 + PO_INFO.findIndex(([f]) => f === 'payment_status');
  info.getCell(`B${statusRow}`).dataValidation = listDV(STATUSES);
  info.getCell(`B${payRow}`).dataValidation = listDV(PAYMENT_STATUSES);

  // --- Lines ---
  const lines = wb.addWorksheet('Lines');
  lines.columns = LINE_HEADERS.map(h => ({ header: h, width: Math.max(12, h.length + 2) }));
  lines.getRow(1).font = { bold: true };
  lines.views = [{ state: 'frozen', ySplit: 1 }];
  const ltCol = lines.getColumn(LINE_HEADERS.indexOf('line_type') + 1).letter;
  for (let r = 2; r <= 201; r++) {
    lines.getCell(`${ltCol}${r}`).dataValidation = listDV(LINE_TYPES);
  }

  // --- Instructions ---
  const ins = wb.addWorksheet('Instructions');
  ins.columns = [{ width: 112 }];
  const para = (t: string) => ins.addRow([t]);
  para('RW Purchase Order — workbook template').font = { bold: true, size: 14 };
  para('');
  para('Fill in the "PO Info" tab and the "Lines" tab, then import:');
  para('    npm run import-purchase-orders -- --workbook "<this file>.xlsx"');
  para('One workbook per PO. To load several at once, put them in a folder and use --workbook-dir "<folder>".');
  para('');
  para('PO INFO TAB — one PO header. Fill the Value column; the Notes column explains each field.');
  para('  - supplier_id: a SUP-id or the exact supplier name (see the list below).');
  para('  - order_date is the date the PO was placed with the supplier — leave it blank while the PO is a draft.');
  para('');
  para('LINES TAB — one row per SKU.');
  para('  - Quantity is split across qty_uk_3pl / qty_fba_uk / qty_usa_awd / qty_rw_held — fill the column(s)');
  para('    where the stock is going. The importer creates one PO line per non-zero quantity column.');
  para('  - If a SKU’s landed cost differs between its UK and USA legs, use TWO rows for it — one carrying the');
  para('    UK-bound quantities + UK costs, one the USA-bound quantities + USA costs.');
  para('  - line_type: product or packaging. A packaging row sets packages_for = the ean of the product it pays');
  para('    for; the importer folds its cost into that product line.');
  para('  - comp_* are per-unit landed-cost components; landed_cost_currency is required if any comp_* is filled.');
  para('    For a draft PO the costs are estimates and do not become COGS until the PO is placed.');
  para('');
  para('SUPPLIERS — use the SUP-id, or the exact name:').font = { bold: true };
  for (const s of suppliers) para('  ' + s);

  await wb.xlsx.writeFile(out);
  console.log(`Wrote PO workbook template -> ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
