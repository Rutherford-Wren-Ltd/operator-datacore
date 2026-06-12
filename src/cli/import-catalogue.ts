#!/usr/bin/env tsx
// ============================================================================
// import-catalogue.ts
// Imports the UPS catalogue (UPS_RW_Catalogue.csv) into brain.sku_master:
// per ASIN -> hs_code_us (US HTS / tariff code), country_of_origin (ISO-2),
// customs_value_usd (declared per-unit customs value). This is the authoritative
// classification UPS uses to clear customs; it drives country-aware duty.
//
// CSV columns: ASIN, Description, Tariff Code, Country of Origin, Unit of Measure, Cost
// Keyed by ASIN (mapped to sku_master rows by asin).
//
// Usage:
//   npm run import-catalogue -- --csv /path/UPS_RW_Catalogue.csv
//   npm run import-catalogue -- --import-dir /path/to/imports   # UPS_RW_Catalogue.csv
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
const empty = (v: string | undefined) => v === undefined || v.trim() === '' || v.trim().toUpperCase() === '#N/A';
const str = (v: string | undefined) => (empty(v) ? null : v!.trim());
const num = (v: string | undefined) => (empty(v) ? null : (Number.isFinite(parseFloat(v!.replace(/[^0-9.\-]/g, ''))) ? parseFloat(v!.replace(/[^0-9.\-]/g, '')) : null));

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { csv: { type: 'string' }, 'import-dir': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  });
  const csvPath = values.csv
    ?? (values['import-dir'] ? path.join(values['import-dir'], 'UPS_RW_Catalogue.csv') : undefined)
    ?? (process.env.IMPORT_DIR ? path.join(process.env.IMPORT_DIR, 'UPS_RW_Catalogue.csv') : undefined);
  if (!csvPath || !existsSync(csvPath)) throw new Error(`File not found (pass --csv or --import-dir): ${csvPath}`);

  const lines = readFileSync(csvPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const idx: Record<string, number> = {};
  parseCSVLine(lines[0]!).forEach((h, i) => { idx[h.trim().toLowerCase()] = i; });
  for (const c of ['asin', 'tariff code', 'country of origin']) if (!(c in idx)) throw new Error(`CSV missing required column: ${c}`);

  console.log('operator-datacore — UPS catalogue import (HS code / origin / customs value)');
  console.log(`  CSV: ${csvPath}  | rows: ${lines.length - 1}  | dry-run: ${values['dry-run']}`);

  const pg = await getPgClient();
  let updated = 0, withCode = 0; const notFound: string[] = [];
  try {
    for (const ln of lines.slice(1)) {
      const r = parseCSVLine(ln);
      const asin = str(r[idx['asin']!]);
      if (!asin) continue;
      const hs = str(r[idx['tariff code']!]);
      const origin = str(r[idx['country of origin']!]);
      const cost = 'cost' in idx ? num(r[idx['cost']!]) : null;
      // guard against column drift: a 2-letter ISO origin only
      const originClean = origin && /^[A-Za-z]{2}$/.test(origin) ? origin.toUpperCase() : null;
      if (hs) withCode++;
      if (values['dry-run']) continue;
      const res = await pg.query(
        `UPDATE brain.sku_master SET
           hs_code_us = COALESCE($2, hs_code_us),
           hs_code_source = CASE WHEN $2 IS NOT NULL THEN 'ups_catalogue' ELSE hs_code_source END,
           country_of_origin = COALESCE($3, country_of_origin),
           customs_value_usd = COALESCE($4, customs_value_usd),
           updated_at = NOW()
         WHERE asin = $1`,
        [asin, hs, originClean, cost],
      );
      if (res.rowCount && res.rowCount > 0) updated += res.rowCount; else notFound.push(asin);
    }
    console.log(`\nRows with a tariff code: ${withCode}  | sku_master rows updated: ${updated}`);
    if (notFound.length) console.log(`ASINs not in sku_master (${notFound.length}): ${notFound.slice(0, 15).join(', ')}${notFound.length > 15 ? ' …' : ''}`);
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
