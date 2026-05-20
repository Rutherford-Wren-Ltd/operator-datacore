// ============================================================================
// po-workbook.ts
// Reads a filled-in standardised PO workbook (.xlsx) and returns header + line
// rows shaped exactly like the purchase-orders.csv / purchase-order-lines.csv
// pair — so import-purchase-orders.ts can consume them through its existing
// parseHeaderRow / parseLineRow / validation / write pipeline unchanged.
//
// Template tabs:
//   "PO Info" — a label / value block (col A label, col B value): one PO header.
//   "Lines"   — one row per SKU. Quantity is split across the qty_uk_3pl /
//               qty_fba_uk / qty_usa_awd / qty_rw_held columns; each non-zero
//               column expands into one DB line at that destination.
// ============================================================================

import ExcelJS from 'exceljs';
import type { CellValue, Row } from 'exceljs';

// Column order of the header / line records — the names here must match what
// import-purchase-orders.ts's parseHeaderRow / parseLineRow look up by name.
export const ORDER_COLUMNS: string[] = [
  'po_number', 'supplier_id', 'status', 'currency', 'order_date',
  'expected_ship_date', 'actual_ship_date', 'expected_arrival_date',
  'actual_arrival_date', 'payment_terms', 'total_value', 'deposit_amount',
  'balance_amount', 'payment_status', 'notes',
];

export const LINE_COLUMNS: string[] = [
  'po_number', 'line_no', 'line_type', 'ean', 'asin', 'supplier_sku',
  'description', 'destination', 'serves_region', 'qty_ordered', 'qty_received',
  'line_status', 'comp_fob', 'comp_lcl', 'comp_import_duty', 'import_duty_rate',
  'comp_qa', 'comp_china_3pl', 'comp_freight_dock', 'comp_photos', 'comp_bond_fee',
  'comp_amz_location_fee', 'comp_azus_storage', 'landed_cost_currency',
  'stated_landed_cost', 'packages_line_no', 'notes',
];

// The Lines-tab quantity columns and the (destination, serves_region) each one
// expands into. Adjust here if RW's destination split changes.
export const QTY_COLUMNS: ReadonlyArray<{ col: string; destination: string; serves_region: string }> = [
  { col: 'qty_uk_3pl',  destination: 'uk_3pl_lemonpath', serves_region: 'uk_eu' },
  { col: 'qty_fba_uk',  destination: 'fba_direct',       serves_region: 'uk_eu' },
  { col: 'qty_usa_awd', destination: 'usa_awd',          serves_region: 'na' },
  { col: 'qty_rw_held', destination: 'rw_held',          serves_region: 'uk_eu' },
];

// Cost / detail columns copied verbatim from a SKU row onto every line it
// expands into.
const COPY_COLUMNS: string[] = [
  'asin', 'supplier_sku', 'description', 'comp_fob', 'comp_lcl', 'comp_import_duty',
  'import_duty_rate', 'comp_qa', 'comp_china_3pl', 'comp_freight_dock', 'comp_photos',
  'comp_bond_fee', 'comp_amz_location_fee', 'comp_azus_storage', 'landed_cost_currency',
  'stated_landed_cost', 'notes',
];

export interface WorkbookResult {
  orderRow: string[];    // aligned to ORDER_COLUMNS
  lineRows: string[][];  // each aligned to LINE_COLUMNS
}

// Normalise a column / label name: lowercase, trim, spaces & hyphens -> '_'.
function key(s: string): string {
  return s.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// Flatten an ExcelJS cell value (string, number, date, rich text, formula
// result, hyperlink) to a plain trimmed string.
function cellText(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const o = v as unknown as Record<string, unknown>;
  if (typeof o.text === 'string') return o.text.trim();
  if ('result' in o) return cellText(o.result as CellValue);
  if (Array.isArray(o.richText)) {
    return o.richText.map((r) => (r as { text?: string }).text ?? '').join('').trim();
  }
  return String(v).trim();
}

// Read one filled-in PO workbook into CSV-pair-shaped header + line rows.
export async function readPoWorkbook(file: string): Promise<WorkbookResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  // ---- PO Info tab → one header record ----
  const info = wb.getWorksheet('PO Info');
  if (!info) throw new Error(`${file}: missing "PO Info" sheet`);
  const infoMap = new Map<string, string>();
  info.eachRow((row) => {
    const label = key(cellText(row.getCell(1).value));
    if (label) infoMap.set(label, cellText(row.getCell(2).value));
  });
  const orderRow = ORDER_COLUMNS.map((c) => infoMap.get(c) ?? '');
  const poNumber = infoMap.get('po_number') ?? '';

  // ---- Lines tab ----
  const linesWs = wb.getWorksheet('Lines');
  if (!linesWs) throw new Error(`${file}: missing "Lines" sheet`);

  const colIdx = new Map<string, number>();
  linesWs.getRow(1).eachCell((cell, c) => {
    const name = key(cellText(cell.value));
    if (name) colIdx.set(name, c);
  });
  const cellOf = (row: Row, name: string): string => {
    const c = colIdx.get(name);
    return c ? cellText(row.getCell(c).value) : '';
  };

  // First pass: expand each SKU row into one pending line per non-zero qty col.
  interface Pending {
    lineNo: number; lineType: string; ean: string;
    destination: string; servesRegion: string; qty: string; row: Row;
  }
  const pending: Pending[] = [];
  let lineNo = 0;
  linesWs.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const ean = cellOf(row, 'ean');
    const description = cellOf(row, 'description');
    const supplierSku = cellOf(row, 'supplier_sku');
    if (!ean && !description && !supplierSku) return; // blank row
    const lineType = key(cellOf(row, 'line_type')) || 'product';
    for (const q of QTY_COLUMNS) {
      const qty = cellOf(row, q.col);
      if (qty !== '' && Number(qty) > 0) {
        pending.push({
          lineNo: ++lineNo, lineType, ean,
          destination: q.destination, servesRegion: q.serves_region, qty, row,
        });
      }
    }
  });

  // Resolve each packaging line's packages_for -> the product line_no of the
  // same ean at the same destination.
  const productLineNo = new Map<string, number>();
  for (const p of pending) {
    if (p.lineType === 'product' && p.ean) {
      productLineNo.set(`${p.ean}|${p.destination}`, p.lineNo);
    }
  }

  const lineRows = pending.map((p) => {
    const rec: Record<string, string> = {
      po_number: poNumber,
      line_no: String(p.lineNo),
      line_type: p.lineType,
      ean: p.ean,
      destination: p.destination,
      serves_region: p.servesRegion,
      qty_ordered: p.qty,
      qty_received: '0',
      line_status: cellOf(p.row, 'line_status') || 'open',
      packages_line_no: '',
    };
    for (const c of COPY_COLUMNS) rec[c] = cellOf(p.row, c);
    if (p.lineType === 'packaging') {
      const target = cellOf(p.row, 'packages_for');
      if (target) {
        rec.packages_line_no = String(productLineNo.get(`${target}|${p.destination}`) ?? '');
      }
    }
    return LINE_COLUMNS.map((c) => rec[c] ?? '');
  });

  return { orderRow, lineRows };
}
