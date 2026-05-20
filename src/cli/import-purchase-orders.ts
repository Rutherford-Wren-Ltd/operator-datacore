#!/usr/bin/env tsx
// ============================================================================
// import-purchase-orders.ts
// Imports purchase-orders.csv + purchase-order-lines.csv into
// brain.purchase_orders + brain.purchase_order_lines (schema v1.5, migration 0015).
// Idempotent — re-run after any PO-sheet edit.
//
// Usage:
//   npm run import-purchase-orders -- --import-dir /path/to/imports
//   npm run import-purchase-orders -- --import-dir /path/to/imports --dry-run
//
// The operator exports the PO workbook to two CSVs in a gitignored folder
// (typically seller-sessions-2026/imports/). This CLI does both the initial
// load of existing open POs and every ongoing update — one mechanism.
//
// v1.5 line model: one row per (PO, SKU, destination). A SKU split UK/USA is
// two product lines. Packaging is its own line_type='packaging' row whose
// per-unit landed cost folds into the product line it points at (via
// packages_line_no), landing in that product's comp_packaging_allocated. Each
// product line's computed landed_cost (post-fold) is upserted into
// brain.sku_landed_cost per (ean, serves_region), newer PO wins.
//
// Header upserts are keyed on po_number. Lines use delete-then-insert per PO so
// a line removed from the sheet is removed from the DB. Unknown EANs (not in
// brain.sku_master) are imported anyway and logged as warnings to meta.sync_log.
// ============================================================================

import { parseArgs } from 'node:util';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getPgClient } from '../lib/supabase.js';
import { readPoWorkbook, ORDER_COLUMNS, LINE_COLUMNS } from '../lib/po-workbook.js';

// ----------------------------------------------------------------------------
// Allowed enum values — must match the CHECK constraints in 0013 / 0015.
// ----------------------------------------------------------------------------
const STATUS_VALUES = ['draft', 'placed', 'confirmed', 'in_production',
  'shipped', 'at_destination', 'received', 'closed', 'cancelled'];
const DESTINATION_VALUES = ['fba_direct', 'uk_3pl_lemonpath', 'usa_awd', 'rw_held'];
const SERVES_REGION_VALUES = ['uk_eu', 'na', 'global'];
const PAYMENT_STATUS_VALUES = ['unpaid', 'deposit_paid', 'paid_in_full', 'not_applicable'];
const LINE_STATUS_VALUES = ['open', 'partial', 'received', 'cancelled'];
const LINE_TYPE_VALUES = ['product', 'packaging'];

// Aliases for the values whose canonical form an operator would not guess.
const DESTINATION_ALIASES: Record<string, string> = {
  fba: 'fba_direct', fba_direct: 'fba_direct', amazon: 'fba_direct',
  uk_3pl: 'uk_3pl_lemonpath', lemonpath: 'uk_3pl_lemonpath', lp: 'uk_3pl_lemonpath',
  '3pl': 'uk_3pl_lemonpath', uk_3pl_lemonpath: 'uk_3pl_lemonpath',
  awd: 'usa_awd', usa_awd: 'usa_awd', us_awd: 'usa_awd',
  rw: 'rw_held', rw_held: 'rw_held', warehouse: 'rw_held',
};
const SERVES_REGION_ALIASES: Record<string, string> = {
  uk: 'uk_eu', eu: 'uk_eu', uk_eu: 'uk_eu',
  us: 'na', usa: 'na', na: 'na', north_america: 'na',
  global: 'global', all: 'global',
};

// Per-unit landed-cost component columns carried in the lines CSV.
// comp_packaging_allocated is deliberately NOT here — the importer computes it
// from the packaging fold; it is not an operator-supplied figure.
const COMP_COLUMNS = [
  'comp_fob', 'comp_lcl', 'comp_import_duty', 'comp_qa', 'comp_china_3pl',
  'comp_freight_dock', 'comp_photos', 'comp_bond_fee', 'comp_amz_location_fee',
  'comp_azus_storage',
] as const;
type CompColumn = (typeof COMP_COLUMNS)[number];

// ----------------------------------------------------------------------------
// Types matching the 0015 schema.
// ----------------------------------------------------------------------------
interface PoHeaderRow {
  po_number: string;
  supplier_id: string;
  status: string;
  currency: string | null;
  order_date: string | null;
  expected_ship_date: string | null;
  actual_ship_date: string | null;
  expected_arrival_date: string | null;
  actual_arrival_date: string | null;
  payment_terms: string | null;
  total_value: number | null;
  deposit_amount: number | null;
  balance_amount: number | null;
  payment_status: string;
  notes: string | null;
}

interface PoLineRow {
  po_number: string;
  line_no: number;
  line_type: 'product' | 'packaging';
  // On a packaging line, the line_no of the product line whose cost it folds
  // into (same PO). NULL on product lines.
  packages_line_no: number | null;
  ean: string | null;
  asin: string | null;
  supplier_sku: string | null;
  description: string | null;
  destination: string;
  serves_region: string;
  qty_ordered: number;
  qty_received: number;
  line_status: string;
  comp: Record<CompColumn, number | null>;
  import_duty_rate: number | null;
  // Set by the packaging fold; NULL on product lines with no packaging line and
  // on packaging lines themselves.
  comp_packaging_allocated: number | null;
  // Computed: sum of the non-NULL comp_* components (incl. comp_packaging_allocated
  // once the fold has run). NULL when the line carries no cost components.
  landed_cost: number | null;
  landed_cost_currency: string | null;
  // Optional operator-stated figure, used only for the drift check.
  stated_landed_cost: number | null;
  notes: string | null;
}

// A (SKU, region) landed-cost figure destined for brain.sku_landed_cost.
interface SlcCandidate {
  ean: string;
  region: string;
  landed_cost: number;
  landed_cost_currency: string;
  as_of_date: string;
  source_po_number: string;
  source_line_no: number;
}

interface ImportStats {
  headers: { created: number; updated: number; skipped: number };
  lines: { inserted: number; deleted: number; skipped: number };
  folds: number;
  skuLandedCost: { inserted: number; updated: number; skippedOlder: number };
  warnings: { message: string; payload: Record<string, unknown> }[];
  errors: string[];
}

// ----------------------------------------------------------------------------
// CSV parsing — respects double-quoted fields with commas.
// ----------------------------------------------------------------------------
function parseCSVLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseCSV(content: string): { header: string[]; rows: string[][] } {
  const stripped = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  const lines = stripped.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) throw new Error('CSV is empty');
  return { header: parseCSVLine(lines[0]!), rows: lines.slice(1).map(parseCSVLine) };
}

function isEmpty(v: string | undefined | null): boolean {
  if (v === undefined || v === null) return true;
  const t = v.trim();
  return t === '' || t === '#N/A';
}

function pickStr(s: string | undefined): string | null {
  return isEmpty(s) ? null : s!.trim();
}
function pickInt(s: string | undefined): number | null {
  if (isEmpty(s)) return null;
  const n = parseInt(s!.trim(), 10);
  return Number.isFinite(n) ? n : null;
}
function pickNum(s: string | undefined): number | null {
  if (isEmpty(s)) return null;
  // Tolerate thousands separators and currency symbols pasted from a workbook.
  const n = parseFloat(s!.trim().replace(/[,£$€\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function buildIndex(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });
  return idx;
}

// Canonicalise loose enum text: lowercase, trim, spaces/hyphens -> underscore.
function canon(s: string | null): string {
  if (!s) return '';
  return s.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// Round to the 6dp the NUMERIC(14,6) columns hold, killing float noise.
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// Sum the non-NULL CSV component columns (excludes comp_packaging_allocated —
// the fold adds that afterwards).
function sumComp(comp: Record<CompColumn, number | null>): number {
  let s = 0;
  for (const c of COMP_COLUMNS) if (comp[c] !== null) s += comp[c]!;
  return round6(s);
}

// ----------------------------------------------------------------------------
// Row parsers — by header name, so a column reorder cannot silently corrupt.
// Each returns either the typed row or an { error } the caller collects.
// ----------------------------------------------------------------------------
function parseHeaderRow(row: string[], idx: Record<string, number>): PoHeaderRow | { error: string } {
  const po_number = pickStr(row[idx['po_number']!]);
  const supplier_id = pickStr(row[idx['supplier_id']!]);
  if (!po_number) return { error: 'header row missing po_number' };
  if (!supplier_id) return { error: `PO ${po_number} missing supplier_id` };

  const statusRaw = canon(pickStr(row[idx['status']!])) || 'draft';
  if (!STATUS_VALUES.includes(statusRaw)) {
    return { error: `PO ${po_number}: status "${statusRaw}" not in ${STATUS_VALUES.join('/')}` };
  }
  const payRaw = canon(pickStr(row[idx['payment_status']!])) || 'unpaid';
  if (!PAYMENT_STATUS_VALUES.includes(payRaw)) {
    return { error: `PO ${po_number}: payment_status "${payRaw}" not in ${PAYMENT_STATUS_VALUES.join('/')}` };
  }

  return {
    po_number,
    supplier_id,
    status: statusRaw,
    currency: pickStr(row[idx['currency']!]),
    order_date: pickStr(row[idx['order_date']!]),
    expected_ship_date: pickStr(row[idx['expected_ship_date']!]),
    actual_ship_date: pickStr(row[idx['actual_ship_date']!]),
    expected_arrival_date: pickStr(row[idx['expected_arrival_date']!]),
    actual_arrival_date: pickStr(row[idx['actual_arrival_date']!]),
    payment_terms: pickStr(row[idx['payment_terms']!]),
    total_value: pickNum(row[idx['total_value']!]),
    deposit_amount: pickNum(row[idx['deposit_amount']!]),
    balance_amount: pickNum(row[idx['balance_amount']!]),
    payment_status: payRaw,
    notes: pickStr(row[idx['notes']!]),
  };
}

function parseLineRow(row: string[], idx: Record<string, number>): PoLineRow | { error: string } {
  const po_number = pickStr(row[idx['po_number']!]);
  const line_no = pickInt(row[idx['line_no']!]);
  if (!po_number) return { error: 'line row missing po_number' };
  if (line_no === null) return { error: `PO ${po_number}: line missing line_no` };

  const lineTypeRaw = canon(pickStr(row[idx['line_type']!])) || 'product';
  if (!LINE_TYPE_VALUES.includes(lineTypeRaw)) {
    return { error: `PO ${po_number} line ${line_no}: line_type "${lineTypeRaw}" not in ${LINE_TYPE_VALUES.join('/')}` };
  }

  const ean = pickStr(row[idx['ean']!]);
  const supplier_sku = pickStr(row[idx['supplier_sku']!]);
  const description = pickStr(row[idx['description']!]);
  if (!ean && !supplier_sku && !description) {
    return { error: `PO ${po_number} line ${line_no}: must carry an ean, supplier_sku or description` };
  }

  const destRaw = DESTINATION_ALIASES[canon(pickStr(row[idx['destination']!]))];
  if (!destRaw) {
    return { error: `PO ${po_number} line ${line_no}: destination "${row[idx['destination']!] ?? ''}" unrecognised (expect ${DESTINATION_VALUES.join('/')} or an alias)` };
  }
  const regionRaw = SERVES_REGION_ALIASES[canon(pickStr(row[idx['serves_region']!]))];
  if (!regionRaw) {
    return { error: `PO ${po_number} line ${line_no}: serves_region "${row[idx['serves_region']!] ?? ''}" unrecognised (expect ${SERVES_REGION_VALUES.join('/')} or an alias)` };
  }

  const qty_ordered = pickInt(row[idx['qty_ordered']!]);
  if (qty_ordered === null) return { error: `PO ${po_number} line ${line_no}: missing qty_ordered` };
  if (qty_ordered < 0) return { error: `PO ${po_number} line ${line_no}: qty_ordered must be >= 0` };
  const qty_received = pickInt(row[idx['qty_received']!]) ?? 0;
  if (qty_received < 0) return { error: `PO ${po_number} line ${line_no}: qty_received must be >= 0` };

  const lineStatusRaw = canon(pickStr(row[idx['line_status']!])) || 'open';
  if (!LINE_STATUS_VALUES.includes(lineStatusRaw)) {
    return { error: `PO ${po_number} line ${line_no}: line_status "${lineStatusRaw}" not in ${LINE_STATUS_VALUES.join('/')}` };
  }

  // packages_line_no links a packaging line to a product line — only valid on
  // packaging lines (the DB CHECK enforces packages_line_id NULL on products).
  const packages_line_no = pickInt(row[idx['packages_line_no']!]);
  if (packages_line_no !== null && lineTypeRaw !== 'packaging') {
    return { error: `PO ${po_number} line ${line_no}: packages_line_no is set but line_type is "${lineTypeRaw}" — only a packaging line links to a product line` };
  }

  // Landed-cost components.
  const comp = {} as Record<CompColumn, number | null>;
  let anyComp = false;
  for (const c of COMP_COLUMNS) {
    const v = pickNum(row[idx[c]!]);
    comp[c] = v;
    if (v !== null) anyComp = true;
  }

  let landed_cost_currency = pickStr(row[idx['landed_cost_currency']!]);
  if (landed_cost_currency && !/^[A-Za-z]{3}$/.test(landed_cost_currency)) {
    return { error: `PO ${po_number} line ${line_no}: landed_cost_currency "${landed_cost_currency}" must be a 3-letter code` };
  }
  if (anyComp && !landed_cost_currency) {
    return { error: `PO ${po_number} line ${line_no}: cost components given but landed_cost_currency is missing` };
  }
  landed_cost_currency = landed_cost_currency ? landed_cost_currency.toUpperCase() : null;

  return {
    po_number,
    line_no,
    line_type: lineTypeRaw as 'product' | 'packaging',
    packages_line_no,
    ean,
    asin: pickStr(row[idx['asin']!]),
    supplier_sku,
    description,
    destination: destRaw,
    serves_region: regionRaw,
    qty_ordered,
    qty_received,
    line_status: lineStatusRaw,
    comp,
    import_duty_rate: pickNum(row[idx['import_duty_rate']!]),
    comp_packaging_allocated: null,
    landed_cost: anyComp ? sumComp(comp) : null,
    landed_cost_currency,
    stated_landed_cost: pickNum(row[idx['stated_landed_cost']!]),
    notes: pickStr(row[idx['notes']!]),
  };
}

// ----------------------------------------------------------------------------
// Packaging fold — each packaging line's per-unit landed cost folds into the
// product line it points at, landing in that product's comp_packaging_allocated
// and re-summing its landed_cost. Mutates the product PoLineRow in place.
// ----------------------------------------------------------------------------
function applyPackagingFold(lines: PoLineRow[], stats: ImportStats): void {
  const productByKey = new Map<string, PoLineRow>();
  for (const l of lines) {
    if (l.line_type === 'product') productByKey.set(`${l.po_number}\u0000${l.line_no}`, l);
  }
  for (const pkg of lines) {
    if (pkg.line_type !== 'packaging') continue;
    if (pkg.packages_line_no === null) {
      stats.warnings.push({
        message: `PO ${pkg.po_number} line ${pkg.line_no}: packaging line has no packages_line_no — its cost folds into no product line`,
        payload: { po_number: pkg.po_number, line_no: pkg.line_no },
      });
      continue;
    }
    const product = productByKey.get(`${pkg.po_number}\u0000${pkg.packages_line_no}`);
    if (!product) {
      stats.errors.push(`PO ${pkg.po_number} line ${pkg.line_no}: packages_line_no ${pkg.packages_line_no} does not match a product line in the same PO`);
      continue;
    }
    const add = pkg.landed_cost ?? 0;
    product.comp_packaging_allocated = round6((product.comp_packaging_allocated ?? 0) + add);
    product.landed_cost = round6((product.landed_cost ?? 0) + add);
    stats.folds++;
  }
}

// ----------------------------------------------------------------------------
// SKU landed-cost candidates — one per (ean, serves_region) across all product
// lines, last-seen wins within an import (a disagreement is warned about).
// Draft and cancelled POs are skipped: their line costs are estimates and must
// never become authoritative COGS in brain.sku_landed_cost.
// ----------------------------------------------------------------------------
function buildSlcCandidates(
  lines: PoLineRow[],
  orderDateByPo: Map<string, string | null>,
  statusByPo: Map<string, string>,
  stats: ImportStats,
): Map<string, SlcCandidate> {
  const out = new Map<string, SlcCandidate>();
  for (const l of lines) {
    if (l.line_type !== 'product') continue;
    // A draft PO's costs are estimates; a cancelled PO's are moot. Either way
    // they do not feed sku_landed_cost — and a draft with no order_date is the
    // expected state, so skip before the order_date check fires a warning.
    const status = statusByPo.get(l.po_number);
    if (status === 'draft' || status === 'cancelled') continue;
    if (!l.ean || l.landed_cost === null || !l.landed_cost_currency) continue;
    const asOf = orderDateByPo.get(l.po_number) ?? null;
    if (!asOf) {
      stats.warnings.push({
        message: `PO ${l.po_number} has no order_date — landed cost for EAN ${l.ean} (${l.serves_region}) not written to brain.sku_landed_cost`,
        payload: { po_number: l.po_number, line_no: l.line_no, ean: l.ean, serves_region: l.serves_region },
      });
      continue;
    }
    const key = `${l.ean}\u0000${l.serves_region}`;
    const prev = out.get(key);
    if (prev && prev.landed_cost !== l.landed_cost) {
      stats.warnings.push({
        message: `EAN ${l.ean} (${l.serves_region}): two product lines in this import disagree on landed cost (${prev.landed_cost} vs ${l.landed_cost}) — using ${l.landed_cost}`,
        payload: { ean: l.ean, serves_region: l.serves_region, first: prev.landed_cost, second: l.landed_cost },
      });
    }
    out.set(key, {
      ean: l.ean,
      region: l.serves_region,
      landed_cost: l.landed_cost,
      landed_cost_currency: l.landed_cost_currency,
      as_of_date: asOf,
      source_po_number: l.po_number,
      source_line_no: l.line_no,
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'import-dir':   { type: 'string' },
      'orders-csv':   { type: 'string' },
      'lines-csv':    { type: 'string' },
      'workbook':     { type: 'string' },
      'workbook-dir': { type: 'string' },
      'dry-run':      { type: 'boolean', default: false },
    },
  });
  const dryRun = !!values['dry-run'];

  console.log('operator-datacore — import purchase orders');
  console.log('-------------------------------------------');

  // Input is either standardised PO workbook(s) (.xlsx) or the CSV pair. Both
  // resolve to the same { header, rows } shape; everything downstream is shared.
  let ordersData: { header: string[]; rows: string[][] };
  let linesData: { header: string[]; rows: string[][] };
  let sourceRef: string;

  const workbook = values['workbook'];
  const workbookDir = values['workbook-dir'];

  if (workbook || workbookDir) {
    let files: string[];
    if (workbookDir) {
      if (!existsSync(workbookDir)) {
        console.error(`Error: workbook dir not found at ${workbookDir}`);
        process.exit(1);
      }
      files = readdirSync(workbookDir)
        .filter(f => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
        .sort()
        .map(f => path.join(workbookDir, f));
      if (files.length === 0) {
        console.error(`Error: no .xlsx files in ${workbookDir}`);
        process.exit(1);
      }
      sourceRef = path.basename(workbookDir);
    } else {
      if (!existsSync(workbook!)) {
        console.error(`Error: workbook not found at ${workbook}`);
        process.exit(1);
      }
      files = [workbook!];
      sourceRef = path.basename(workbook!);
    }
    console.log(`  Workbooks:  ${files.length}`);
    console.log(`  Dry-run:    ${dryRun}`);
    console.log('');
    const orderRows: string[][] = [];
    const allLineRows: string[][] = [];
    for (const f of files) {
      const { orderRow, lineRows } = await readPoWorkbook(f);
      orderRows.push(orderRow);
      allLineRows.push(...lineRows);
      console.log(`  ${path.basename(f)} — ${lineRows.length} line(s)`);
    }
    console.log('');
    ordersData = { header: ORDER_COLUMNS, rows: orderRows };
    linesData = { header: LINE_COLUMNS, rows: allLineRows };
  } else {
    const importDir = values['import-dir'] ?? process.env.IMPORT_DIR;
    const ordersCsv = values['orders-csv']
      ?? (importDir ? path.join(importDir, 'purchase-orders.csv') : undefined);
    const linesCsv = values['lines-csv']
      ?? (importDir ? path.join(importDir, 'purchase-order-lines.csv') : undefined);
    if (!ordersCsv || !linesCsv) {
      console.error('Error: pass --workbook / --workbook-dir, or --import-dir, or both --orders-csv and --lines-csv (or set IMPORT_DIR).');
      process.exit(1);
    }
    if (!existsSync(ordersCsv)) {
      console.error(`Error: purchase-orders CSV not found at ${ordersCsv}`);
      process.exit(1);
    }
    if (!existsSync(linesCsv)) {
      console.error(`Error: purchase-order-lines CSV not found at ${linesCsv}`);
      process.exit(1);
    }
    console.log(`  Orders CSV: ${ordersCsv}`);
    console.log(`  Lines CSV:  ${linesCsv}`);
    console.log(`  Dry-run:    ${dryRun}`);
    console.log('');
    ordersData = parseCSV(readFileSync(ordersCsv, 'utf8'));
    linesData = parseCSV(readFileSync(linesCsv, 'utf8'));
    sourceRef = path.basename(ordersCsv);
  }

  const ordersIdx = buildIndex(ordersData.header);
  const linesIdx = buildIndex(linesData.header);

  for (const col of ['po_number', 'supplier_id', 'status']) {
    if (!(col in ordersIdx)) {
      console.error(`Error: purchase-orders CSV missing required column '${col}'`);
      process.exit(1);
    }
  }
  for (const col of ['po_number', 'line_no', 'destination', 'serves_region', 'qty_ordered']) {
    if (!(col in linesIdx)) {
      console.error(`Error: purchase-order-lines CSV missing required column '${col}'`);
      process.exit(1);
    }
  }

  const stats: ImportStats = {
    headers: { created: 0, updated: 0, skipped: 0 },
    lines: { inserted: 0, deleted: 0, skipped: 0 },
    folds: 0,
    skuLandedCost: { inserted: 0, updated: 0, skippedOlder: 0 },
    warnings: [],
    errors: [],
  };

  const headers: PoHeaderRow[] = [];
  for (const row of ordersData.rows) {
    const parsed = parseHeaderRow(row, ordersIdx);
    if ('error' in parsed) { stats.errors.push(parsed.error); stats.headers.skipped++; continue; }
    headers.push(parsed);
  }

  const lines: PoLineRow[] = [];
  for (const row of linesData.rows) {
    const parsed = parseLineRow(row, linesIdx);
    if ('error' in parsed) { stats.errors.push(parsed.error); stats.lines.skipped++; continue; }
    lines.push(parsed);
  }

  // Every line's po_number must match a header.
  const headerNumbers = new Set(headers.map(h => h.po_number));
  for (const l of lines) {
    if (!headerNumbers.has(l.po_number)) {
      stats.errors.push(`Line for PO ${l.po_number} (line ${l.line_no}) has no matching header row.`);
    }
  }

  // Duplicate detection — both would otherwise blow up mid-transaction with a
  // raw constraint error (po_lines_line_no_unique / po_lines_natural_key).
  const lineNoSeen = new Set<string>();
  const natKeySeen = new Set<string>();
  for (const l of lines) {
    const lk = `${l.po_number}\u0000${l.line_no}`;
    if (lineNoSeen.has(lk)) stats.errors.push(`PO ${l.po_number}: duplicate line_no ${l.line_no}`);
    lineNoSeen.add(lk);
    if (l.ean) {
      const nk = `${l.po_number}\u0000${l.ean}\u0000${l.destination}\u0000${l.line_type}`;
      if (natKeySeen.has(nk)) {
        stats.errors.push(`PO ${l.po_number}: duplicate (ean ${l.ean}, destination ${l.destination}, ${l.line_type}) — collapses to one row`);
      }
      natKeySeen.add(nk);
    }
  }

  // Packaging fold + landed-cost drift check (no DB needed).
  applyPackagingFold(lines, stats);
  for (const l of lines) {
    if (l.line_type !== 'product') continue;
    if (l.stated_landed_cost === null || l.landed_cost === null) continue;
    const diff = Math.abs(l.landed_cost - l.stated_landed_cost);
    const tol = Math.max(0.01, Math.abs(l.stated_landed_cost) * 0.01);
    if (diff > tol) {
      stats.warnings.push({
        message: `PO ${l.po_number} line ${l.line_no}: computed landed_cost ${l.landed_cost} drifts from stated ${l.stated_landed_cost} (diff ${round6(diff)})`,
        payload: { po_number: l.po_number, line_no: l.line_no, computed: l.landed_cost, stated: l.stated_landed_cost },
      });
    }
  }

  if (stats.errors.length > 0) {
    console.error(`Refusing to import — ${stats.errors.length} hard error(s):`);
    for (const e of stats.errors) console.error(`  ${e}`);
    process.exit(1);
  }

  const productCount = lines.filter(l => l.line_type === 'product').length;
  const packagingCount = lines.length - productCount;
  console.log(`Parsed ${headers.length} PO headers, ${lines.length} PO lines `
    + `(${productCount} product, ${packagingCount} packaging).`);
  if (stats.folds > 0) console.log(`Packaging fold: ${stats.folds} line(s) folded into their product line.`);
  console.log('');

  const orderDateByPo = new Map(headers.map(h => [h.po_number, h.order_date]));
  const statusByPo = new Map(headers.map(h => [h.po_number, h.status]));
  const slcCandidates = buildSlcCandidates(lines, orderDateByPo, statusByPo, stats);

  const pg = await getPgClient();
  try {
    // Validate supplier_ids + load EAN set, all before opening the write txn.
    const { rows: supRows } = await pg.query<{ supplier_id: string; name: string }>(
      'SELECT supplier_id, name FROM brain.supplier_master',
    );
    const knownSuppliers = new Set(supRows.map(r => r.supplier_id));
    // The workbook PO Info tab may give a supplier name instead of a SUP-id;
    // resolve names here so the rest of the importer only deals in ids.
    const supplierByName = new Map(supRows.map(r => [r.name.trim().toLowerCase(), r.supplier_id]));
    for (const h of headers) {
      if (!knownSuppliers.has(h.supplier_id)) {
        const resolved = supplierByName.get(h.supplier_id.trim().toLowerCase());
        if (resolved) h.supplier_id = resolved;
      }
    }
    const unknownSuppliers = [...new Set(headers.map(h => h.supplier_id))]
      .filter(s => !knownSuppliers.has(s));
    if (unknownSuppliers.length > 0) {
      console.error(`Refusing to import — supplier(s) not in brain.supplier_master: ${unknownSuppliers.join(', ')}`);
      console.error('Use the SUP-id or the exact supplier name; add new suppliers via import-masters first.');
      process.exit(1);
    }

    const { rows: skuRows } = await pg.query<{ ean: string; asin: string | null }>(
      'SELECT ean, asin FROM brain.sku_master',
    );
    const eanToAsin = new Map(skuRows.map(r => [r.ean, r.asin]));

    // Collect EAN warnings (unknown EANs are imported anyway), backfill asin.
    for (const l of lines) {
      if (l.ean && !eanToAsin.has(l.ean)) {
        stats.warnings.push({
          message: `PO ${l.po_number} line ${l.line_no}: EAN ${l.ean} not in brain.sku_master`,
          payload: { po_number: l.po_number, line_no: l.line_no, ean: l.ean, asin: l.asin },
        });
      }
      if (!l.asin && l.ean && eanToAsin.get(l.ean)) {
        l.asin = eanToAsin.get(l.ean)!;
      }
    }

    if (dryRun) {
      console.log('--dry-run — no DB writes.');
      console.log(`Would upsert ${headers.length} headers, replace lines for ${new Set(lines.map(l => l.po_number)).size} PO(s).`);

      // Resolve the newer-wins outcome for sku_landed_cost against current DB state.
      const cand = [...slcCandidates.values()];
      if (cand.length > 0) {
        const { rows: existing } = await pg.query<{ ean: string; region: string; as_of_date: string }>(
          `SELECT ean, region, as_of_date::text AS as_of_date FROM brain.sku_landed_cost
           WHERE (ean, region) IN (${cand.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(',')})`,
          cand.flatMap(c => [c.ean, c.region]),
        );
        const existingAsOf = new Map(existing.map(r => [`${r.ean}\u0000${r.region}`, r.as_of_date]));
        let wIns = 0, wUpd = 0, wSkip = 0;
        for (const c of cand) {
          const prior = existingAsOf.get(`${c.ean}\u0000${c.region}`);
          if (prior === undefined) wIns++;
          else if (c.as_of_date >= prior) wUpd++;
          else wSkip++;
        }
        console.log(`sku_landed_cost: would insert ${wIns}, update ${wUpd}, skip ${wSkip} (older PO).`);
        for (const c of cand.slice(0, 20)) {
          console.log(`  ${c.ean} ${c.region}: ${c.landed_cost} ${c.landed_cost_currency} (as of ${c.as_of_date})`);
        }
        if (cand.length > 20) console.log(`  ... and ${cand.length - 20} more`);
      }

      if (stats.warnings.length) {
        console.log('');
        console.log(`${stats.warnings.length} warning(s):`);
        for (const w of stats.warnings.slice(0, 30)) console.log(`  ${w.message}`);
        if (stats.warnings.length > 30) console.log(`  ... and ${stats.warnings.length - 30} more`);
      }
      return;
    }

    // Bookkeeping: connection + sync_run.
    const { rows: connRows } = await pg.query<{ connection_id: string }>(
      `INSERT INTO meta.connection (source, label, status)
       VALUES ('operator_local', 'po-import', 'active')
       ON CONFLICT (source, label) DO UPDATE
         SET updated_at = NOW(), last_health_check_at = NOW(), last_health_check_ok = TRUE
       RETURNING connection_id`,
    );
    const connectionId = connRows[0]!.connection_id;

    const orderDates = headers.map(h => h.order_date).filter((d): d is string => !!d).sort();
    const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
      `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
       VALUES ($1, 'operator_local', 'purchase_orders', 'manual', $2, $3)
       RETURNING sync_run_id`,
      [connectionId, orderDates[0] ?? null, orderDates[orderDates.length - 1] ?? null],
    );
    const syncRunId = runRows[0]!.sync_run_id;
    const startedAt = Date.now();

    await pg.query('BEGIN');
    // Attribute status-history rows (written by the 0013 trigger) to this run.
    await pg.query(`SET LOCAL app.change_source = 'import:${syncRunId}'`);

    // Phase 1: upsert headers, capture po_number -> po_id.
    const poIdByNumber = new Map<string, string>();
    for (const h of headers) {
      const res = await pg.query<{ po_id: string; inserted: boolean }>(
        `INSERT INTO brain.purchase_orders (
           po_number, supplier_id, status, currency,
           order_date, expected_ship_date, actual_ship_date,
           expected_arrival_date, actual_arrival_date,
           payment_terms, total_value, deposit_amount, balance_amount,
           payment_status, source_system, source_ref, notes
         ) VALUES (
           $1,$2,$3,$4,
           $5,$6,$7,
           $8,$9,
           $10,$11,$12,$13,
           $14,'operator_csv',$15,$16
         )
         ON CONFLICT (po_number) DO UPDATE SET
           supplier_id           = EXCLUDED.supplier_id,
           status                = EXCLUDED.status,
           currency              = EXCLUDED.currency,
           order_date            = EXCLUDED.order_date,
           expected_ship_date    = EXCLUDED.expected_ship_date,
           actual_ship_date      = EXCLUDED.actual_ship_date,
           expected_arrival_date = EXCLUDED.expected_arrival_date,
           actual_arrival_date   = EXCLUDED.actual_arrival_date,
           payment_terms         = EXCLUDED.payment_terms,
           total_value           = EXCLUDED.total_value,
           deposit_amount        = EXCLUDED.deposit_amount,
           balance_amount        = EXCLUDED.balance_amount,
           payment_status        = EXCLUDED.payment_status,
           source_ref            = EXCLUDED.source_ref,
           notes                 = EXCLUDED.notes,
           updated_at            = NOW()
         RETURNING po_id, (xmax = 0) AS inserted`,
        [
          h.po_number, h.supplier_id, h.status, h.currency,
          h.order_date, h.expected_ship_date, h.actual_ship_date,
          h.expected_arrival_date, h.actual_arrival_date,
          h.payment_terms, h.total_value, h.deposit_amount, h.balance_amount,
          h.payment_status, sourceRef, h.notes,
        ],
      );
      poIdByNumber.set(h.po_number, res.rows[0]!.po_id);
      if (res.rows[0]!.inserted) stats.headers.created++;
      else stats.headers.updated++;
    }

    // Phase 2: lines, delete-then-insert per PO that appears in the lines CSV.
    // Product lines insert first so a packaging line can resolve packages_line_id.
    const linesByPo = new Map<string, PoLineRow[]>();
    for (const l of lines) {
      (linesByPo.get(l.po_number) ?? linesByPo.set(l.po_number, []).get(l.po_number)!).push(l);
    }
    const lineIdByKey = new Map<string, string>();
    for (const [poNumber, poLines] of linesByPo) {
      const poId = poIdByNumber.get(poNumber)!;
      const del = await pg.query('DELETE FROM brain.purchase_order_lines WHERE po_id = $1', [poId]);
      stats.lines.deleted += del.rowCount ?? 0;

      const ordered = [...poLines].sort((a, b) =>
        (a.line_type === 'packaging' ? 1 : 0) - (b.line_type === 'packaging' ? 1 : 0));
      const lineIdByNo = new Map<number, string>();
      for (const l of ordered) {
        const packagesLineId = l.line_type === 'packaging' && l.packages_line_no !== null
          ? lineIdByNo.get(l.packages_line_no) ?? null
          : null;
        const res = await pg.query<{ po_line_id: string }>(
          `INSERT INTO brain.purchase_order_lines (
             po_id, line_no, line_type, packages_line_id,
             ean, asin, supplier_sku, description,
             destination, serves_region, qty_ordered, qty_received, line_status,
             comp_fob, comp_lcl, comp_import_duty, import_duty_rate, comp_qa,
             comp_china_3pl, comp_freight_dock, comp_photos, comp_bond_fee,
             comp_amz_location_fee, comp_azus_storage, comp_packaging_allocated,
             landed_cost, landed_cost_currency, notes
           ) VALUES (
             $1,$2,$3,$4,
             $5,$6,$7,$8,
             $9,$10,$11,$12,$13,
             $14,$15,$16,$17,$18,
             $19,$20,$21,$22,
             $23,$24,$25,
             $26,$27,$28
           )
           RETURNING po_line_id`,
          [
            poId, l.line_no, l.line_type, packagesLineId,
            l.ean, l.asin, l.supplier_sku, l.description,
            l.destination, l.serves_region, l.qty_ordered, l.qty_received, l.line_status,
            l.comp.comp_fob, l.comp.comp_lcl, l.comp.comp_import_duty, l.import_duty_rate, l.comp.comp_qa,
            l.comp.comp_china_3pl, l.comp.comp_freight_dock, l.comp.comp_photos, l.comp.comp_bond_fee,
            l.comp.comp_amz_location_fee, l.comp.comp_azus_storage, l.comp_packaging_allocated,
            l.landed_cost, l.landed_cost_currency, l.notes,
          ],
        );
        const poLineId = res.rows[0]!.po_line_id;
        lineIdByNo.set(l.line_no, poLineId);
        lineIdByKey.set(`${poNumber}\u0000${l.line_no}`, poLineId);
        stats.lines.inserted++;
      }
    }

    // Phase 3: upsert brain.sku_landed_cost from product lines (packaging folded
    // in). The WHERE guard means an older PO never regresses a newer figure.
    for (const c of slcCandidates.values()) {
      const sourcePoId = poIdByNumber.get(c.source_po_number) ?? null;
      const sourceLineId = lineIdByKey.get(`${c.source_po_number}\u0000${c.source_line_no}`) ?? null;
      const up = await pg.query<{ inserted: boolean }>(
        `INSERT INTO brain.sku_landed_cost
           (ean, region, landed_cost, landed_cost_currency, as_of_date, source_po_id, source_po_line_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (ean, region) DO UPDATE SET
           landed_cost          = EXCLUDED.landed_cost,
           landed_cost_currency = EXCLUDED.landed_cost_currency,
           as_of_date           = EXCLUDED.as_of_date,
           source_po_id         = EXCLUDED.source_po_id,
           source_po_line_id    = EXCLUDED.source_po_line_id,
           updated_at           = NOW()
         WHERE EXCLUDED.as_of_date >= brain.sku_landed_cost.as_of_date
         RETURNING (xmax = 0) AS inserted`,
        [c.ean, c.region, c.landed_cost, c.landed_cost_currency, c.as_of_date, sourcePoId, sourceLineId],
      );
      if (up.rowCount === 0) stats.skuLandedCost.skippedOlder++;
      else if (up.rows[0]!.inserted) stats.skuLandedCost.inserted++;
      else stats.skuLandedCost.updated++;
    }

    // Write warnings to meta.sync_log.
    for (const w of stats.warnings) {
      await pg.query(
        `INSERT INTO meta.sync_log (sync_run_id, level, message, payload)
         VALUES ($1, 'warn', $2, $3)`,
        [syncRunId, w.message, JSON.stringify(w.payload)],
      );
    }

    await pg.query('COMMIT');

    const totalUpserted = stats.headers.created + stats.headers.updated
      + stats.lines.inserted + stats.skuLandedCost.inserted + stats.skuLandedCost.updated;
    // meta.sync_run.duration_ms is a GENERATED column — never write it.
    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = 'success',
             rows_fetched = $2, rows_upserted = $2
       WHERE sync_run_id = $1`,
      [syncRunId, totalUpserted],
    );

    console.log('Done.');
    console.log(`Headers:         ${stats.headers.created} created, ${stats.headers.updated} updated, ${stats.headers.skipped} skipped`);
    console.log(`Lines:           ${stats.lines.inserted} inserted, ${stats.lines.deleted} deleted (replaced), ${stats.lines.skipped} skipped`);
    console.log(`Packaging folds: ${stats.folds}`);
    console.log(`sku_landed_cost: ${stats.skuLandedCost.inserted} inserted, ${stats.skuLandedCost.updated} updated, ${stats.skuLandedCost.skippedOlder} skipped (older PO)`);
    if (stats.warnings.length) {
      console.log('');
      console.log(`${stats.warnings.length} warning(s) logged to meta.sync_log:`);
      for (const w of stats.warnings.slice(0, 30)) console.log(`  ${w.message}`);
      if (stats.warnings.length > 30) console.log(`  ... and ${stats.warnings.length - 30} more`);
    }
    console.log(`\nsync_run_id ${syncRunId} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {});
    console.error('Import failed, rolled back:', err);
    process.exit(1);
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
