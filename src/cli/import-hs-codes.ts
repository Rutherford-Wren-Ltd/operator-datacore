#!/usr/bin/env tsx
// ============================================================================
// import-hs-codes.ts
// Imports sku-hs-codes.csv (EAN -> hs_code_us, hs_code_uk) into brain.sku_master.
// hs_code_us drives US import-duty resolution (analytics.sku_us_duty ->
// brain.us_import_duty_rate). Both HS columns are written in one per-EAN upsert.
//
// CSV columns: ean, hs_code_us, hs_code_uk, notes.  '#N/A' / blank -> NULL.
//
// Usage:
//   npm run import-hs-codes -- --csv /path/sku-hs-codes.csv
//   npm run import-hs-codes -- --import-dir /path/to/imports   # reads sku-hs-codes.csv
//   npm run import-hs-codes -- --csv ... --dry-run
// ============================================================================

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getPgClient } from '../lib/supabase.js';

function parseCSVLine(line: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function isEmpty(v: string | undefined): boolean {
  if (v === undefined) return true;
  const t = v.trim();
  return t === '' || t.toUpperCase() === '#N/A' || t === '#REF!';
}
const clean = (v: string | undefined) => (isEmpty(v) ? null : v!.trim());

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { csv: { type: 'string' }, 'import-dir': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  });
  const csvPath = values.csv
    ?? (values['import-dir'] ? path.join(values['import-dir'], 'sku-hs-codes.csv') : undefined)
    ?? (process.env.IMPORT_DIR ? path.join(process.env.IMPORT_DIR, 'sku-hs-codes.csv') : undefined);
  if (!csvPath || !existsSync(csvPath)) throw new Error(`File not found (pass --csv or --import-dir): ${csvPath}`);

  const lines = readFileSync(csvPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const idx: Record<string, number> = {};
  parseCSVLine(lines[0]!).forEach((h, i) => { idx[h.trim().toLowerCase()] = i; });
  if (!('ean' in idx)) throw new Error('CSV missing required column: ean');

  console.log('operator-datacore — SKU HS-code import');
  console.log(`  CSV: ${csvPath}  | rows: ${lines.length - 1}  | dry-run: ${values['dry-run']}`);

  const pg = await getPgClient();
  let updated = 0, withUs = 0; const notFound: string[] = [];
  try {
    for (const ln of lines.slice(1)) {
      const r = parseCSVLine(ln);
      const ean = clean(r[idx['ean']!]);
      if (!ean) continue;
      const hsUs = clean(r[idx['hs_code_us']!]);
      const hsUk = clean(r[idx['hs_code_uk']!]);
      if (hsUs) withUs++;
      if (values['dry-run']) continue;
      const res = await pg.query(
        `UPDATE brain.sku_master SET
           hs_code_us = COALESCE($2, hs_code_us),
           hs_code_uk = COALESCE($3, hs_code_uk),
           hs_code_source = CASE WHEN $2 IS NOT NULL OR $3 IS NOT NULL THEN 'csv' ELSE hs_code_source END,
           updated_at = NOW()
         WHERE ean = $1`,
        [ean, hsUs, hsUk],
      );
      if (res.rowCount && res.rowCount > 0) updated += res.rowCount; else notFound.push(ean);
    }
    console.log(`\nRows with a US HS code: ${withUs}  | sku_master rows updated: ${updated}`);
    if (notFound.length) console.log(`EANs not in sku_master (${notFound.length}): ${notFound.slice(0, 15).join(', ')}${notFound.length > 15 ? ' …' : ''}`);
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
