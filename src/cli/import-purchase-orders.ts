#!/usr/bin/env tsx
// ============================================================================
// import-purchase-orders.ts
// Imports purchase-orders.csv + purchase-order-lines.csv into
// brain.purchase_orders + brain.purchase_order_lines (added in migration 0013).
// Idempotent — re-run after any PO-sheet edit.
//
// Usage:
//   npm run import-purchase-orders -- --import-dir /path/to/imports
//   npm run import-purchase-orders -- --import-dir /path/to/imports --dry-run
//
// The operator exports the Google Drive PO sheet to two CSVs in a gitignored
// folder (typically seller-sessions-2026/imports/). This CLI does both the
// initial load of existing open POs and every ongoing update — one mechanism.
//
// Header upserts are keyed on po_number. Lines use delete-then-insert per PO so
// a line removed from the sheet is removed from the DB. Unknown EANs (not in
// brain.sku_master) are imported anyway and logged as warnings to meta.sync_log.
// ============================================================================

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getPgClient } from '../lib/supabase.js';

// ----------------------------------------------------------------------------
// Allowed enum values — must match the CHECK constraints in 0013.
// ----------------------------------------------------------------------------
const STATUS_VALUES = ['draft', 'placed', 'confirmed', 'in_production',
  'shipped', 'at_destination', 'received', 'closed', 'cancelled'];
const DESTINATION_VALUES = ['fba_direct', 'uk_3pl_lemonpath', 'usa_awd', 'rw_held'];
const SERVES_REGION_VALUES = ['uk_eu', 'na', 'global'];
const PAYMENT_STATUS_VALUES = ['unpaid', 'deposit_paid', 'paid_in_full', 'not_applicable'];
const LINE_STATUS_VALUES = ['open', 'partial', 'received', 'cancelled'];

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

// ----------------------------------------------------------------------------
// Types matching the 0013 schema.
// ----------------------------------------------------------------------------
interface PoHeaderRow {
  po_number: string;
  supplier_id: string;
  status: string;
  destination: string;
  serves_region: string;
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
  ean: string | null;
  asin: string | null;
  supplier_sku: string | null;
  description: string | null;
  qty_ordered: number;
  qty_received: number;
  unit_cost: number | null;
  line_status: string;
  notes: string | null;
}

interface ImportStats {
  headers: { created: number; updated: number; skipped: number };
  lines: { inserted: number; deleted: number; skipped: number };
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
  const stripped = content.replace(/^﻿/, '');
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
  const n = parseFloat(s!.trim());
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
  const destRaw = DESTINATION_ALIASES[canon(pickStr(row[idx['destination']!]))];
  if (!destRaw) {
    return { error: `PO ${po_number}: destination "${row[idx['destination']!] ?? ''}" unrecognised (expect fba_direct/uk_3pl_lemonpath/usa_awd/rw_held or an alias)` };
  }
  const regionRaw = SERVES_REGION_ALIASES[canon(pickStr(row[idx['serves_region']!]))];
  if (!regionRaw) {
    return { error: `PO ${po_number}: serves_region "${row[idx['serves_region']!] ?? ''}" unrecognised (expect uk_eu/na/global or an alias)` };
  }
  const payRaw = canon(pickStr(row[idx['payment_status']!])) || 'unpaid';
  if (!PAYMENT_STATUS_VALUES.includes(payRaw)) {
    return { error: `PO ${po_number}: payment_status "${payRaw}" not in ${PAYMENT_STATUS_VALUES.join('/')}` };
  }

  return {
    po_number,
    supplier_id,
    status: statusRaw,
    destination: destRaw,
    serves_region: regionRaw,
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

  const ean = pickStr(row[idx['ean']!]);
  const supplier_sku = pickStr(row[idx['supplier_sku']!]);
  const description = pickStr(row[idx['description']!]);
  if (!ean && !supplier_sku && !description) {
    return { error: `PO ${po_number} line ${line_no}: must carry an ean, supplier_sku or description` };
  }
  const qty_ordered = pickInt(row[idx['qty_ordered']!]);
  if (qty_ordered === null) return { error: `PO ${po_number} line ${line_no}: missing qty_ordered` };

  const lineStatusRaw = canon(pickStr(row[idx['line_status']!])) || 'open';
  if (!LINE_STATUS_VALUES.includes(lineStatusRaw)) {
    return { error: `PO ${po_number} line ${line_no}: line_status "${lineStatusRaw}" not in ${LINE_STATUS_VALUES.join('/')}` };
  }

  return {
    po_number,
    line_no,
    ean,
    asin: pickStr(row[idx['asin']!]),
    supplier_sku,
    description,
    qty_ordered,
    qty_received: pickInt(row[idx['qty_received']!]) ?? 0,
    unit_cost: pickNum(row[idx['unit_cost']!]),
    line_status: lineStatusRaw,
    notes: pickStr(row[idx['notes']!]),
  };
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
      'dry-run':      { type: 'boolean', default: false },
    },
  });

  const importDir = values['import-dir'] ?? process.env.IMPORT_DIR;
  const ordersCsv = values['orders-csv']
    ?? (importDir ? path.join(importDir, 'purchase-orders.csv') : undefined);
  const linesCsv = values['lines-csv']
    ?? (importDir ? path.join(importDir, 'purchase-order-lines.csv') : undefined);
  const dryRun = !!values['dry-run'];

  if (!ordersCsv || !linesCsv) {
    console.error('Error: pass --import-dir, or both --orders-csv and --lines-csv (or set IMPORT_DIR).');
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

  console.log('operator-datacore — import purchase orders');
  console.log('-------------------------------------------');
  console.log(`  Orders CSV: ${ordersCsv}`);
  console.log(`  Lines CSV:  ${linesCsv}`);
  console.log(`  Dry-run:    ${dryRun}`);
  console.log('');

  const ordersData = parseCSV(readFileSync(ordersCsv, 'utf8'));
  const linesData = parseCSV(readFileSync(linesCsv, 'utf8'));
  const ordersIdx = buildIndex(ordersData.header);
  const linesIdx = buildIndex(linesData.header);

  for (const col of ['po_number', 'supplier_id', 'status', 'destination', 'serves_region']) {
    if (!(col in ordersIdx)) {
      console.error(`Error: purchase-orders CSV missing required column '${col}'`);
      process.exit(1);
    }
  }
  for (const col of ['po_number', 'line_no', 'qty_ordered']) {
    if (!(col in linesIdx)) {
      console.error(`Error: purchase-order-lines CSV missing required column '${col}'`);
      process.exit(1);
    }
  }

  const stats: ImportStats = {
    headers: { created: 0, updated: 0, skipped: 0 },
    lines: { inserted: 0, deleted: 0, skipped: 0 },
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

  if (stats.errors.length > 0) {
    console.error(`Refusing to import — ${stats.errors.length} hard error(s):`);
    for (const e of stats.errors) console.error(`  ${e}`);
    process.exit(1);
  }

  console.log(`Parsed ${headers.length} PO headers, ${lines.length} PO lines.`);
  console.log('');

  const pg = await getPgClient();
  try {
    // Validate supplier_ids + load EAN set, all before opening the write txn.
    const { rows: supRows } = await pg.query<{ supplier_id: string }>(
      'SELECT supplier_id FROM brain.supplier_master',
    );
    const knownSuppliers = new Set(supRows.map(r => r.supplier_id));
    const unknownSuppliers = [...new Set(headers.map(h => h.supplier_id))]
      .filter(s => !knownSuppliers.has(s));
    if (unknownSuppliers.length > 0) {
      console.error(`Refusing to import — supplier_id(s) not in brain.supplier_master: ${unknownSuppliers.join(', ')}`);
      console.error('Add them to supplier-master.csv and run import-masters first.');
      process.exit(1);
    }

    const { rows: skuRows } = await pg.query<{ ean: string; asin: string | null }>(
      'SELECT ean, asin FROM brain.sku_master',
    );
    const eanToAsin = new Map(skuRows.map(r => [r.ean, r.asin]));

    // Collect EAN warnings (unknown EANs are imported anyway).
    for (const l of lines) {
      if (l.ean && !eanToAsin.has(l.ean)) {
        stats.warnings.push({
          message: `PO ${l.po_number} line ${l.line_no}: EAN ${l.ean} not in brain.sku_master`,
          payload: { po_number: l.po_number, line_no: l.line_no, ean: l.ean, asin: l.asin },
        });
      }
      // Backfill asin from sku_master when the line omits it but the EAN resolves.
      if (!l.asin && l.ean && eanToAsin.get(l.ean)) {
        l.asin = eanToAsin.get(l.ean)!;
      }
    }

    if (dryRun) {
      console.log('--dry-run — no DB writes.');
      console.log(`Would upsert ${headers.length} headers, replace lines for ${new Set(lines.map(l => l.po_number)).size} PO(s).`);
      if (stats.warnings.length) {
        console.log('');
        console.log(`${stats.warnings.length} EAN warning(s):`);
        for (const w of stats.warnings.slice(0, 20)) console.log(`  ${w.message}`);
        if (stats.warnings.length > 20) console.log(`  ... and ${stats.warnings.length - 20} more`);
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
           po_number, supplier_id, status, destination, serves_region, currency,
           order_date, expected_ship_date, actual_ship_date,
           expected_arrival_date, actual_arrival_date,
           payment_terms, total_value, deposit_amount, balance_amount,
           payment_status, source_system, source_ref, notes
         ) VALUES (
           $1,$2,$3,$4,$5,$6,
           $7,$8,$9,
           $10,$11,
           $12,$13,$14,$15,
           $16,'operator_csv',$17,$18
         )
         ON CONFLICT (po_number) DO UPDATE SET
           supplier_id           = EXCLUDED.supplier_id,
           status                = EXCLUDED.status,
           destination           = EXCLUDED.destination,
           serves_region         = EXCLUDED.serves_region,
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
          h.po_number, h.supplier_id, h.status, h.destination, h.serves_region, h.currency,
          h.order_date, h.expected_ship_date, h.actual_ship_date,
          h.expected_arrival_date, h.actual_arrival_date,
          h.payment_terms, h.total_value, h.deposit_amount, h.balance_amount,
          h.payment_status, path.basename(ordersCsv), h.notes,
        ],
      );
      poIdByNumber.set(h.po_number, res.rows[0]!.po_id);
      if (res.rows[0]!.inserted) stats.headers.created++;
      else stats.headers.updated++;
    }

    // Phase 2: lines, delete-then-insert per PO that appears in the lines CSV.
    const linesByPo = new Map<string, PoLineRow[]>();
    for (const l of lines) {
      (linesByPo.get(l.po_number) ?? linesByPo.set(l.po_number, []).get(l.po_number)!).push(l);
    }
    for (const [poNumber, poLines] of linesByPo) {
      const poId = poIdByNumber.get(poNumber)!;
      const del = await pg.query('DELETE FROM brain.purchase_order_lines WHERE po_id = $1', [poId]);
      stats.lines.deleted += del.rowCount ?? 0;
      for (const l of poLines) {
        await pg.query(
          `INSERT INTO brain.purchase_order_lines (
             po_id, line_no, ean, asin, supplier_sku, description,
             qty_ordered, qty_received, unit_cost, line_status, notes
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            poId, l.line_no, l.ean, l.asin, l.supplier_sku, l.description,
            l.qty_ordered, l.qty_received, l.unit_cost, l.line_status, l.notes,
          ],
        );
        stats.lines.inserted++;
      }
    }

    // Write EAN warnings to meta.sync_log.
    for (const w of stats.warnings) {
      await pg.query(
        `INSERT INTO meta.sync_log (sync_run_id, level, message, payload)
         VALUES ($1, 'warn', $2, $3)`,
        [syncRunId, w.message, JSON.stringify(w.payload)],
      );
    }

    await pg.query('COMMIT');

    const totalUpserted = stats.headers.created + stats.headers.updated + stats.lines.inserted;
    // meta.sync_run.duration_ms is a GENERATED column — never write it.
    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = 'success',
             rows_fetched = $2, rows_upserted = $2
       WHERE sync_run_id = $1`,
      [syncRunId, totalUpserted],
    );

    console.log('Done.');
    console.log(`Headers: ${stats.headers.created} created, ${stats.headers.updated} updated, ${stats.headers.skipped} skipped`);
    console.log(`Lines:   ${stats.lines.inserted} inserted, ${stats.lines.deleted} deleted (replaced), ${stats.lines.skipped} skipped`);
    if (stats.warnings.length) {
      console.log('');
      console.log(`${stats.warnings.length} EAN warning(s) logged to meta.sync_log:`);
      for (const w of stats.warnings.slice(0, 20)) console.log(`  ${w.message}`);
      if (stats.warnings.length > 20) console.log(`  ... and ${stats.warnings.length - 20} more`);
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
