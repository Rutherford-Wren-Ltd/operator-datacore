#!/usr/bin/env tsx
// ============================================================================
// import-packaging.ts
// Imports sku-packaging.csv (EAN-keyed carton pack-out + dimensions) into the
// packaging columns of brain.sku_master. This is the authoritative case-quantity
// source for inbound (3PL->FBA) freight costing — NOT derived/calculated.
//
// CSV columns (header, by name):
//   ean, master_carton_qty, carton_length_cm, carton_width_cm,
//   carton_height_cm, carton_gross_weight_kg, notes
//
// '#N/A' (and blank) are treated as NULL — those SKUs arrive loose and are
// reworked at inbound, so they have no clean master carton and fall back to the
// volumetric cost model in analytics.product_profitability_30d.
//
// Idempotent: re-run after any edit. Matches on EAN; SKUs not in sku_master are
// reported as warnings (add them to sku-master.csv first).
//
// Usage:
//   npm run import-packaging -- --csv /path/to/sku-packaging.csv
//   npm run import-packaging -- --import-dir /path/to/imports   # reads sku-packaging.csv
//   npm run import-packaging -- --csv ... --dry-run
// ============================================================================

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getPgClient } from '../lib/supabase.js';

function parseCSVLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
    } else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function isEmpty(v: string | undefined): boolean {
  if (v === undefined) return true;
  const t = v.trim();
  return t === '' || t.toUpperCase() === '#N/A' || t === '#REF!';
}
function num(v: string | undefined): number | null {
  if (isEmpty(v)) return null;
  const n = parseFloat(v!.trim());
  return Number.isFinite(n) ? n : null;
}
function int(v: string | undefined): number | null {
  if (isEmpty(v)) return null;
  const n = parseInt(v!.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null; // 0 / negative case qty is meaningless -> null
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      csv:          { type: 'string' },
      'import-dir': { type: 'string' },
      'dry-run':    { type: 'boolean', default: false },
    },
  });

  const csvPath = values.csv
    ?? (values['import-dir'] ? path.join(values['import-dir'], 'sku-packaging.csv') : undefined)
    ?? (process.env.IMPORT_DIR ? path.join(process.env.IMPORT_DIR, 'sku-packaging.csv') : undefined);
  if (!csvPath) throw new Error('Pass --csv <file> or --import-dir <dir> (or set IMPORT_DIR).');
  if (!existsSync(csvPath)) throw new Error(`File not found: ${csvPath}`);

  const content = readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = parseCSVLine(lines[0]!);
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { idx[h.trim().toLowerCase()] = i; });
  const need = ['ean', 'master_carton_qty'];
  for (const c of need) if (!(c in idx)) throw new Error(`CSV missing required column: ${c}`);

  const rows = lines.slice(1).map(parseCSVLine);
  console.log('operator-datacore — SKU packaging import');
  console.log('----------------------------------------');
  console.log(`  CSV:     ${csvPath}`);
  console.log(`  Rows:    ${rows.length}`);
  console.log(`  Dry run: ${values['dry-run']}`);
  console.log('');

  const pg = await getPgClient();
  let updated = 0, withQty = 0, naCount = 0;
  const notFound: string[] = [];
  try {
    for (const r of rows) {
      const ean = r[idx['ean']!]?.trim();
      if (!ean || isEmpty(ean)) continue;
      const upc = int(r[idx['master_carton_qty']!]);
      const l = num(r[idx['carton_length_cm']!]);
      const w = num(r[idx['carton_width_cm']!]);
      const h = num(r[idx['carton_height_cm']!]);
      const wt = num(r[idx['carton_gross_weight_kg']!]);
      if (upc === null) naCount++; else withQty++;

      if (values['dry-run']) continue;
      const res = await pg.query(
        `UPDATE brain.sku_master SET
           units_per_case        = $2::integer,
           units_per_case_source = CASE WHEN $2::integer IS NOT NULL THEN 'csv' ELSE units_per_case_source END,
           carton_length_cm      = $3::numeric,
           carton_width_cm       = $4::numeric,
           carton_height_cm      = $5::numeric,
           carton_weight_kg      = $6::numeric,
           updated_at            = NOW()
         WHERE ean = $1`,
        [ean, upc, l, w, h, wt],
      );
      if (res.rowCount && res.rowCount > 0) updated += res.rowCount;
      else notFound.push(ean);
    }
    console.log(`Rows with a master carton qty: ${withQty}  |  #N/A (volumetric fallback): ${naCount}`);
    console.log(`sku_master rows updated:       ${updated}`);
    if (notFound.length) {
      console.log(`\nEANs not in sku_master (${notFound.length}) — add to sku-master.csv first:`);
      console.log('  ' + notFound.slice(0, 20).join(', ') + (notFound.length > 20 ? ' …' : ''));
    }
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
