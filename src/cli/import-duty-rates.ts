#!/usr/bin/env tsx
// ============================================================================
// import-duty-rates.ts
// Imports us-duty-rates.csv into brain.us_import_duty_rate (HS-code -> US import
// duty %). `total_pct` is authoritative; base/section_301/reciprocal are for
// transparency + what-if. hs_code '*' is the catch-all default. Upsert keyed on
// (hs_code, effective_from) so rate changes are versioned by date.
//
// CSV columns: hs_code, base_pct, section_301_pct, reciprocal_pct, total_pct,
//              effective_from, notes.   Percentages as decimals (0.602 = 60.2%).
//
// Usage:
//   npm run import-duty-rates -- --csv /path/us-duty-rates.csv
//   npm run import-duty-rates -- --import-dir /path/to/imports   # us-duty-rates.csv
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
const num = (v: string | undefined) => (empty(v) ? null : (Number.isFinite(parseFloat(v!)) ? parseFloat(v!) : null));
const str = (v: string | undefined) => (empty(v) ? null : v!.trim());

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { csv: { type: 'string' }, 'import-dir': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  });
  const csvPath = values.csv
    ?? (values['import-dir'] ? path.join(values['import-dir'], 'us-duty-rates.csv') : undefined)
    ?? (process.env.IMPORT_DIR ? path.join(process.env.IMPORT_DIR, 'us-duty-rates.csv') : undefined);
  if (!csvPath || !existsSync(csvPath)) throw new Error(`File not found (pass --csv or --import-dir): ${csvPath}`);

  const lines = readFileSync(csvPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const idx: Record<string, number> = {};
  parseCSVLine(lines[0]!).forEach((h, i) => { idx[h.trim().toLowerCase()] = i; });
  for (const c of ['hs_code', 'total_pct']) if (!(c in idx)) throw new Error(`CSV missing required column: ${c}`);

  console.log('operator-datacore — US duty-rate import');
  console.log(`  CSV: ${csvPath}  | rows: ${lines.length - 1}  | dry-run: ${values['dry-run']}`);

  const pg = await getPgClient();
  let upserted = 0;
  try {
    for (const ln of lines.slice(1)) {
      const r = parseCSVLine(ln);
      const hs = str(r[idx['hs_code']!]);
      const total = num(r[idx['total_pct']!]);
      if (!hs || total === null) continue;
      const eff = str(r[idx['effective_from']!]) ?? '2025-01-01';
      if (values['dry-run']) { upserted++; continue; }
      await pg.query(
        `INSERT INTO brain.us_import_duty_rate
           (hs_code, base_pct, section_301_pct, reciprocal_pct, total_pct, effective_from, notes, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (hs_code, effective_from) DO UPDATE SET
           base_pct=EXCLUDED.base_pct, section_301_pct=EXCLUDED.section_301_pct,
           reciprocal_pct=EXCLUDED.reciprocal_pct, total_pct=EXCLUDED.total_pct,
           notes=EXCLUDED.notes, updated_at=NOW()`,
        [hs, num(r[idx['base_pct']!]), num(r[idx['section_301_pct']!]), num(r[idx['reciprocal_pct']!]), total, eff, str(r[idx['notes']!])],
      );
      upserted++;
    }
    console.log(`\n${upserted} duty-rate row(s) upserted into brain.us_import_duty_rate.`);
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
