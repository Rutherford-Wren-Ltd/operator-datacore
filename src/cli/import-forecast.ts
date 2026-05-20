#!/usr/bin/env tsx
// ============================================================================
// import-forecast.ts
// Imports RW's demand forecast (the "Unit forecast" workbook) into
// brain.demand_forecast (added in migration 0017). Each run is a dated
// snapshot; re-running keeps history.
//
// Usage:
//   npm run import-forecast -- --workbook "<Unit forecast.xlsx>"
//   npm run import-forecast -- --workbook "<file>" --snapshot-date 2026-06-01 --dry-run
//
// Workbook shape (one sheet, "Sheet1"):
//   Rows 1-3 = headers, rows 4+ = one SKU each.
//   Per SKU, cols 1-8: EAN (col 1 — the header mislabels it "SupplierName"),
//   brand, title, category, supplier, GBP/USD/EUR price.
//   From col 9: repeating monthly blocks — UK | USA | DE | Total (4-col) up to
//   Aug 2025, then UK | USA | DE | UKW | Total (5-col). Row 1 = year, row 2 =
//   "<Month> Forecast|Actual|Var". Only Forecast blocks are ingested. DE maps
//   to market 'eu' (the tool's DE column is all-EU); UKW = UK website / MFN.
// ============================================================================

import { parseArgs } from 'node:util';
import path from 'node:path';
import { existsSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { getPgClient } from '../lib/supabase.js';

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
// A block's row-3 sub-header tokens map to these markets ('total' is derived
// and ingested as nothing). The tool's "DE" column is the whole-EU pool;
// "UKW" is UK website / MFN sales. Blocks are 4 columns (UK/USA/DE/Total) up
// to Aug 2025, then 5 (UK/USA/DE/UKW/Total) — the walker handles both.
const SUBHEADER_MARKET: Record<string, string> = {
  uk: 'uk', usa: 'usa', de: 'eu', ukw: 'ukw',
};
const VALID_BLOCK_SHAPES = new Set(['uk,usa,de,total', 'uk,usa,de,ukw,total']);
const FIRST_BLOCK_COL = 9;   // 1-based: col 9 is the first UK column

interface ForecastRow {
  ean: string;
  asin: string | null;
  market: string;
  forecast_month: string;   // YYYY-MM-01
  units: number;
}
interface Warning { message: string; payload: Record<string, unknown>; }

// Flatten an ExcelJS cell value to a trimmed string.
function cellText(v: ExcelJS.CellValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const o = v as unknown as Record<string, unknown>;
  if (typeof o.text === 'string') return o.text.trim();
  if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
  if (Array.isArray(o.richText)) {
    return o.richText.map((r) => (r as { text?: string }).text ?? '').join('').trim();
  }
  return String(v).trim();
}
// A numeric cell value, or null if blank / non-numeric.
function cellNum(v: ExcelJS.CellValue | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(cellText(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'workbook':      { type: 'string' },
      'snapshot-date': { type: 'string' },
      'dry-run':       { type: 'boolean', default: false },
    },
  });

  const workbook = values['workbook'];
  const dryRun = !!values['dry-run'];
  const snapshotDate = values['snapshot-date'] ?? new Date().toISOString().slice(0, 10);

  if (!workbook) {
    console.error('Error: --workbook "<path to the Unit forecast .xlsx>" is required.');
    process.exit(1);
  }
  if (!existsSync(workbook)) {
    console.error(`Error: workbook not found at ${workbook}`);
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
    console.error(`Error: --snapshot-date "${snapshotDate}" must be YYYY-MM-DD.`);
    process.exit(1);
  }

  console.log('operator-datacore — import demand forecast');
  console.log('-------------------------------------------');
  console.log(`  Workbook:      ${workbook}`);
  console.log(`  Snapshot date: ${snapshotDate}`);
  console.log(`  Dry-run:       ${dryRun}`);
  console.log('');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbook);
  const ws = wb.getWorksheet('Sheet1');
  if (!ws) {
    console.error('Error: the workbook has no "Sheet1" — not the expected forecast tool.');
    process.exit(1);
  }

  const lastCol = ws.columnCount;
  const lastRow = ws.rowCount;
  const row1 = ws.getRow(1).values as (ExcelJS.CellValue | undefined)[];
  const row2 = ws.getRow(2).values as (ExcelJS.CellValue | undefined)[];
  const row3 = ws.getRow(3).values as (ExcelJS.CellValue | undefined)[];

  // --- Structural pre-check: the grid must start with a UK column. ---
  if (cellText(row3[FIRST_BLOCK_COL]).toLowerCase() !== 'uk') {
    console.error(`Error: Sheet1 row 3 column ${FIRST_BLOCK_COL} should start a `
      + 'UK/USA/DE/Total block — not the expected forecast tool.');
    process.exit(1);
  }

  // --- Walk the monthly blocks. A block runs from a row-3 'UK' cell to its
  // 'Total' cell — 4 wide (UK/USA/DE/Total) up to Aug 2025, 5 wide
  // (UK/USA/DE/UKW/Total) after. Every block's shape is validated; an
  // unrecognised shape fails the import rather than misreading columns. ---
  interface Block { year: number; month: number; markets: { col: number; market: string }[]; }
  const forecastBlocks: Block[] = [];
  const errors: string[] = [];
  let c = FIRST_BLOCK_COL;
  while (c <= lastCol) {
    if (cellText(row3[c]).toLowerCase() !== 'uk') { c++; continue; }
    // Read the block's row-3 sub-headers, up to and including 'total'.
    const sub: string[] = [];
    const cols: number[] = [];
    let cc = c;
    while (cc <= lastCol && cc - c <= 6) {
      const tok = cellText(row3[cc]).toLowerCase();
      sub.push(tok);
      cols.push(cc);
      if (tok === 'total') break;
      cc++;
    }
    const shape = sub.join(',');
    if (!VALID_BLOCK_SHAPES.has(shape)) {
      errors.push(`column ${c}: unrecognised block shape "${shape}" — expected `
        + 'UK/USA/DE/Total or UK/USA/DE/UKW/Total; the forecast tool\'s layout has changed.');
      break;
    }
    const period = cellText(row2[c]);
    if (/forecast/i.test(period)) {
      const month = MONTHS[period.toLowerCase().split(/\s+/)[0] ?? ''];
      const yearText = cellText(row1[c]);
      const year = parseInt(yearText, 10);
      if (!month) {
        errors.push(`column ${c}: forecast block has an unrecognised month label "${period}"`);
      } else if (!yearText || !Number.isFinite(year) || year < 2000 || year > 2100) {
        errors.push(`column ${c}: forecast block "${period}" has no valid year in row 1 `
          + `(found "${yearText}") — every Forecast block must carry its year.`);
      } else {
        const markets = sub
          .map((tok, i) => ({ col: cols[i]!, market: SUBHEADER_MARKET[tok] ?? '' }))
          .filter((x) => x.market !== '');
        forecastBlocks.push({ year, month, markets });
      }
    }
    c = cc + 1;   // advance past this block (cc is the 'total' column)
  }

  if (errors.length > 0) {
    console.error(`Refusing to import — ${errors.length} structural error(s):`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  if (forecastBlocks.length === 0) {
    console.error('Error: no Forecast blocks found in the workbook.');
    process.exit(1);
  }

  // --- Walk SKU rows, expand each Forecast block into per-market rows. ---
  const forecastRows: ForecastRow[] = [];
  const warnings: Warning[] = [];
  let skuCount = 0;
  for (let r = 4; r <= lastRow; r++) {
    const vals = ws.getRow(r).values as (ExcelJS.CellValue | undefined)[];
    const ean = cellText(vals[1]);          // col 1 — headed "SupplierName" but is the EAN
    if (!ean) continue;                     // blank row
    skuCount++;
    for (const b of forecastBlocks) {
      const fm = `${b.year}-${String(b.month).padStart(2, '0')}-01`;
      for (const m of b.markets) {
        // Stored exactly — units_forecast is NUMERIC; the tool emits fractional
        // figures (esp. in UKW) and per-cell rounding would lose accuracy.
        const units = cellNum(vals[m.col]);
        if (units === null || units <= 0) continue;
        forecastRows.push({ ean, asin: null, market: m.market, forecast_month: fm, units });
      }
    }
  }

  console.log(`Parsed ${skuCount} SKU rows, ${forecastBlocks.length} Forecast blocks `
    + `-> ${forecastRows.length} forecast rows.`);
  const totalUnits = forecastRows.reduce((s, f) => s + f.units, 0);
  console.log(`Total forecast units: ${totalUnits}`);
  console.log('');

  const pg = await getPgClient();
  try {
    // Validate EANs + backfill asin (unknown EANs import anyway, with a warning).
    const { rows: skuRows } = await pg.query<{ ean: string; asin: string | null }>(
      'SELECT ean, asin FROM brain.sku_master',
    );
    const eanToAsin = new Map(skuRows.map((r) => [r.ean, r.asin]));
    const unknownEans = new Set<string>();
    for (const f of forecastRows) {
      if (eanToAsin.has(f.ean)) f.asin = eanToAsin.get(f.ean) ?? null;
      else unknownEans.add(f.ean);
    }
    for (const e of [...unknownEans].sort()) {
      warnings.push({ message: `EAN ${e} not in brain.sku_master`, payload: { ean: e } });
    }

    if (dryRun) {
      console.log('--dry-run — no DB writes.');
      console.log(`Would write ${forecastRows.length} rows for snapshot ${snapshotDate}.`);
      if (warnings.length) {
        console.log('');
        console.log(`${warnings.length} warning(s):`);
        for (const w of warnings.slice(0, 30)) console.log(`  ${w.message}`);
        if (warnings.length > 30) console.log(`  ... and ${warnings.length - 30} more`);
      }
      return;
    }

    // Bookkeeping: connection + sync_run.
    const { rows: connRows } = await pg.query<{ connection_id: string }>(
      `INSERT INTO meta.connection (source, label, status)
       VALUES ('operator_local', 'forecast-import', 'active')
       ON CONFLICT (source, label) DO UPDATE
         SET updated_at = NOW(), last_health_check_at = NOW(), last_health_check_ok = TRUE
       RETURNING connection_id`,
    );
    const connectionId = connRows[0]!.connection_id;
    const months = forecastRows.map((f) => f.forecast_month).sort();
    const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
      `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
       VALUES ($1, 'operator_local', 'demand_forecast', 'manual', $2, $3)
       RETURNING sync_run_id`,
      [connectionId, months[0] ?? null, months[months.length - 1] ?? null],
    );
    const syncRunId = runRows[0]!.sync_run_id;
    const startedAt = Date.now();
    const sourceRef = path.basename(workbook);

    await pg.query('BEGIN');
    // Replace this snapshot, demote the prior current snapshot, insert anew.
    await pg.query(
      "DELETE FROM brain.demand_forecast WHERE snapshot_date = $1 AND source = 'operator_tool'",
      [snapshotDate],
    );
    await pg.query(
      "UPDATE brain.demand_forecast SET is_current = FALSE WHERE source = 'operator_tool' AND is_current = TRUE",
    );
    const COLS = 8;
    for (let i = 0; i < forecastRows.length; i += 500) {
      const chunk = forecastRows.slice(i, i + 500);
      const valuesSql = chunk
        .map((_, j) => `($${j * COLS + 1},$${j * COLS + 2},$${j * COLS + 3},$${j * COLS + 4},`
          + `$${j * COLS + 5},$${j * COLS + 6},$${j * COLS + 7},$${j * COLS + 8})`)
        .join(',');
      const params = chunk.flatMap((f) => [
        snapshotDate, 'operator_tool', f.ean, f.asin, f.market, f.forecast_month, f.units, sourceRef,
      ]);
      await pg.query(
        `INSERT INTO brain.demand_forecast
           (snapshot_date, source, ean, asin, market, forecast_month, units_forecast, source_ref)
         VALUES ${valuesSql}`,
        params,
      );
    }
    for (const w of warnings) {
      await pg.query(
        `INSERT INTO meta.sync_log (sync_run_id, level, message, payload)
         VALUES ($1, 'warn', $2, $3)`,
        [syncRunId, w.message, JSON.stringify(w.payload)],
      );
    }
    await pg.query('COMMIT');

    // meta.sync_run.duration_ms is a GENERATED column — never write it.
    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = 'success', rows_fetched = $2, rows_upserted = $2
       WHERE sync_run_id = $1`,
      [syncRunId, forecastRows.length],
    );

    console.log('Done.');
    console.log(`Inserted ${forecastRows.length} forecast rows, snapshot ${snapshotDate} `
      + `(now is_current).`);
    if (warnings.length) {
      console.log('');
      console.log(`${warnings.length} warning(s) logged to meta.sync_log:`);
      for (const w of warnings.slice(0, 30)) console.log(`  ${w.message}`);
      if (warnings.length > 30) console.log(`  ... and ${warnings.length - 30} more`);
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
