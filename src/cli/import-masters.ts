#!/usr/bin/env tsx
// ============================================================================
// import-masters.ts
// Imports supplier-master.csv + sku-master.csv into brain.supplier_master and
// brain.sku_master. Idempotent — re-run after any master edit.
//
// Usage:
//   npm run import-masters -- --import-dir /path/to/imports
//   npm run import-masters -- --supplier-csv /a.csv --sku-csv /b.csv
//   npm run import-masters -- --import-dir /path --dry-run
//
// The master CSVs are treated as sensitive — they live in a gitignored
// location (typically seller-sessions-2026/imports/), are read on the
// operator's machine only, and never leave it via this CLI. Only the
// columns mapped into brain.* schemas are persisted to Supabase.
// ============================================================================

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getPgClient } from '../lib/supabase.js';

// ----------------------------------------------------------------------------
// Types matching the schema in 0011_brain_supplier_sku_master.sql
// ----------------------------------------------------------------------------
interface SupplierRow {
  supplier_id: string;
  name: string;
  country: string | null;
  city: string | null;
  factory_or_trader: string | null;
  moq: number | null;
  lead_time_days: number | null;
  payment_terms: string | null;
  incoterms: string | null;
  currency: string | null;
  since_month: string | null;
  status: string;
}

interface SkuRow {
  asin: string | null;
  seller_sku: string | null;
  ean: string;
  brand: string;
  supplier_name_raw: string | null;
  moq: number | null;
  lead_time_days: number | null;
  cogs_landed: number | null;
  fba_fee: number | null;
  launched: string | null;
  status: string;
  marketplace: string | null;
  parent_asin: string | null;
}

interface ImportStats {
  suppliers: { created: number; updated: number; skipped: number };
  skus: { created: number; updated: number; skipped: number };
  warnings: string[];
  errors: string[];
}

// ----------------------------------------------------------------------------
// CSV parsing — respects quoted fields with commas (e.g. supplier names).
// ----------------------------------------------------------------------------
function parseCSVLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
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
  // Strip UTF-8 BOM if Excel added one on Save-As.
  const stripped = content.replace(/^﻿/, '');
  const lines = stripped.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) throw new Error('CSV is empty');
  const header = parseCSVLine(lines[0]!);
  const rows = lines.slice(1).map(parseCSVLine);
  return { header, rows };
}

function isEmpty(v: string | undefined | null): boolean {
  if (v === undefined || v === null) return true;
  const t = v.trim();
  return t === '' || t === '#N/A';
}

// ----------------------------------------------------------------------------
// Typo normalisation. These are the recurring issues in the masters; fix
// silently so the database reflects intended values. Source files unchanged.
// ----------------------------------------------------------------------------
function normalizeText(s: string | null): string | null {
  if (s === null) return null;
  return s
    .replace(/Instanbul/g, 'Istanbul')
    .replace(/proir/g, 'prior')
    .replace(/seperate/g, 'separate');
}

// Status values in master use mixed formats. Map to the canonical set the
// schema CHECK constraint allows.
function normalizeSkuStatus(raw: string | null): string {
  if (isEmpty(raw)) return 'unknown';
  const v = raw!.trim().toLowerCase();
  if (v === 'on hold') return 'on_hold';
  if (v === 'new launch') return 'new_launch';
  if (['active', 'seasonal', 'discontinued', 'unknown'].includes(v)) return v;
  return 'unknown'; // unrecognised → unknown (warn separately)
}

function normalizeSupplierStatus(raw: string | null): string {
  if (isEmpty(raw)) return 'active';
  const v = raw!.trim().toLowerCase();
  if (['active', 'paused', 'dormant', 'dropped'].includes(v)) return v;
  return 'active';
}

// ----------------------------------------------------------------------------
// Row parsers. Column lookup by header name (not by position) so a column
// reorder in the source CSV doesn't silently corrupt the import.
// ----------------------------------------------------------------------------
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

function pickStr(s: string | undefined): string | null {
  if (isEmpty(s)) return null;
  return s!.trim();
}

function buildIndex(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });
  return idx;
}

function parseSupplierRow(row: string[], idx: Record<string, number>): SupplierRow | { error: string } {
  const supplier_id = pickStr(row[idx['supplier_id']!]);
  const name = pickStr(row[idx['name']!]);
  if (!supplier_id) return { error: 'missing supplier_id' };
  if (!name) return { error: `supplier ${supplier_id} has no name` };

  return {
    supplier_id,
    name: normalizeText(name)!,
    country: normalizeText(pickStr(row[idx['country']!])),
    city: normalizeText(pickStr(row[idx['city']!])),
    factory_or_trader: pickStr(row[idx['factory_or_trader']!]),
    moq: pickInt(row[idx['moq']!]),
    lead_time_days: pickInt(row[idx['lead_time_days']!]),
    payment_terms: normalizeText(pickStr(row[idx['payment_terms']!])),
    incoterms: normalizeText(pickStr(row[idx['incoterms']!])),
    currency: pickStr(row[idx['currency']!]),
    since_month: pickStr(row[idx['since']!]),
    status: normalizeSupplierStatus(pickStr(row[idx['status']!])),
  };
}

function parseSkuRow(row: string[], idx: Record<string, number>): SkuRow | { error: string } {
  const ean = pickStr(row[idx['ean']!]);
  const brand = pickStr(row[idx['brand']!]);
  if (!ean) return { error: 'row missing ean (required NOT NULL)' };
  if (!brand) return { error: `EAN ${ean} has no brand` };

  return {
    asin: pickStr(row[idx['asin']!]),
    seller_sku: pickStr(row[idx['seller_sku']!]),
    ean,
    brand,
    supplier_name_raw: pickStr(row[idx['supplier_name']!]),
    moq: pickInt(row[idx['moq']!]),
    lead_time_days: pickInt(row[idx['lead_time_days']!]),
    cogs_landed: pickNum(row[idx['cogs_landed']!]),
    fba_fee: pickNum(row[idx['fba_fee']!]),
    launched: pickStr(row[idx['launched']!]),
    status: normalizeSkuStatus(pickStr(row[idx['status']!])),
    marketplace: pickStr(row[idx['marketplace']!]),
    parent_asin: pickStr(row[idx['parent_asin']!]),
  };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'import-dir':    { type: 'string' },
      'supplier-csv':  { type: 'string' },
      'sku-csv':       { type: 'string' },
      'dry-run':       { type: 'boolean', default: false },
    },
  });

  const importDir = values['import-dir'] ?? process.env.IMPORT_DIR;
  const supplierCsv = values['supplier-csv']
    ?? (importDir ? path.join(importDir, 'supplier-master.csv') : undefined);
  const skuCsv = values['sku-csv']
    ?? (importDir ? path.join(importDir, 'sku-master.csv') : undefined);
  const dryRun = !!values['dry-run'];

  if (!supplierCsv || !skuCsv) {
    console.error('Error: must pass --import-dir, or both --supplier-csv and --sku-csv (or set IMPORT_DIR).');
    process.exit(1);
  }
  if (!existsSync(supplierCsv)) {
    console.error(`Error: supplier CSV not found at ${supplierCsv}`);
    process.exit(1);
  }
  if (!existsSync(skuCsv)) {
    console.error(`Error: SKU CSV not found at ${skuCsv}`);
    process.exit(1);
  }

  console.log('operator-datacore — import masters');
  console.log('-----------------------------------');
  console.log(`  Supplier CSV: ${supplierCsv}`);
  console.log(`  SKU CSV:      ${skuCsv}`);
  console.log(`  Dry-run:      ${dryRun}`);
  console.log('');

  // Parse both CSVs into typed rows first (no DB connection needed).
  const supplierCsvContent = readFileSync(supplierCsv, 'utf8');
  const skuCsvContent = readFileSync(skuCsv, 'utf8');

  const supplierData = parseCSV(supplierCsvContent);
  const skuData = parseCSV(skuCsvContent);

  const supplierIdx = buildIndex(supplierData.header);
  const skuIdx = buildIndex(skuData.header);

  // Validate required columns are present in each file.
  for (const col of ['supplier_id', 'name', 'status']) {
    if (!(col in supplierIdx)) {
      console.error(`Error: supplier CSV missing required column '${col}'`);
      process.exit(1);
    }
  }
  for (const col of ['ean', 'brand']) {
    if (!(col in skuIdx)) {
      console.error(`Error: SKU CSV missing required column '${col}'`);
      process.exit(1);
    }
  }

  const stats: ImportStats = {
    suppliers: { created: 0, updated: 0, skipped: 0 },
    skus: { created: 0, updated: 0, skipped: 0 },
    warnings: [],
    errors: [],
  };

  const suppliers: SupplierRow[] = [];
  for (const row of supplierData.rows) {
    const parsed = parseSupplierRow(row, supplierIdx);
    if ('error' in parsed) {
      stats.errors.push(`Supplier row: ${parsed.error}`);
      stats.suppliers.skipped++;
      continue;
    }
    suppliers.push(parsed);
  }

  const skus: SkuRow[] = [];
  for (const row of skuData.rows) {
    const parsed = parseSkuRow(row, skuIdx);
    if ('error' in parsed) {
      stats.warnings.push(`SKU row: ${parsed.error}`);
      stats.skus.skipped++;
      continue;
    }
    skus.push(parsed);
  }

  // Build supplier name → supplier_id lookup. When a name maps to multiple
  // IDs (Maiktoli case: SUP-008 Nhava Sheva + SUP-009 Tuticorin), we record
  // the ambiguity and resolve to the first ID encountered with a warning.
  const nameToIds: Record<string, string[]> = {};
  for (const s of suppliers) {
    (nameToIds[s.name] ??= []).push(s.supplier_id);
  }
  function resolveSupplier(rawName: string | null): string | null {
    if (!rawName) return null;
    const cleaned = normalizeText(rawName);
    if (!cleaned) return null;
    const ids = nameToIds[cleaned];
    if (!ids || ids.length === 0) return null;
    if (ids.length > 1) {
      stats.warnings.push(
        `Ambiguous supplier name "${cleaned}" maps to ${ids.length} IDs ` +
        `(${ids.join(', ')}); using first (${ids[0]}). Disambiguate in supplier-master.csv.`,
      );
    }
    return ids[0]!;
  }

  console.log(`Parsed ${suppliers.length} supplier rows, ${skus.length} SKU rows.`);
  console.log(`Skipped: ${stats.suppliers.skipped} suppliers, ${stats.skus.skipped} SKUs.`);
  console.log('');

  if (dryRun) {
    console.log('--dry-run: no DB writes. Sample of first 3 of each:');
    console.log('Suppliers:', JSON.stringify(suppliers.slice(0, 3), null, 2));
    console.log('SKUs:', JSON.stringify(skus.slice(0, 3), null, 2));
    if (stats.warnings.length) {
      console.log('');
      console.log('Warnings:');
      for (const w of stats.warnings) console.log(`  ${w}`);
    }
    if (stats.errors.length) {
      console.log('');
      console.log('Errors:');
      for (const e of stats.errors) console.log(`  ${e}`);
    }
    return;
  }

  const pg = await getPgClient();

  try {
    // Record this import in meta.sync_run for audit trail. Reuse the
    // 'operator_local' connection or create it.
    const { rows: connRows } = await pg.query<{ connection_id: string }>(
      `INSERT INTO meta.connection (source, label, status)
       VALUES ('operator_local', 'master-import', 'active')
       ON CONFLICT (source, label) DO UPDATE
         SET updated_at = NOW(), last_health_check_at = NOW(), last_health_check_ok = TRUE
       RETURNING connection_id`,
    );
    const connectionId = connRows[0]!.connection_id;

    const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
      `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
       VALUES ($1, 'operator_local', 'master_import', 'manual', NOW(), NOW())
       RETURNING sync_run_id`,
      [connectionId],
    );
    const syncRunId = runRows[0]!.sync_run_id;
    const startedAt = Date.now();

    await pg.query('BEGIN');

    // Phase 1: upsert suppliers.
    for (const s of suppliers) {
      const result = await pg.query<{ inserted: boolean }>(
        `INSERT INTO brain.supplier_master (
           supplier_id, name, country, city, factory_or_trader,
           moq, lead_time_days, payment_terms, incoterms, currency,
           since_month, status
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10,
           $11, $12
         )
         ON CONFLICT (supplier_id) DO UPDATE SET
           name              = EXCLUDED.name,
           country           = EXCLUDED.country,
           city              = EXCLUDED.city,
           factory_or_trader = EXCLUDED.factory_or_trader,
           moq               = EXCLUDED.moq,
           lead_time_days    = EXCLUDED.lead_time_days,
           payment_terms     = EXCLUDED.payment_terms,
           incoterms         = EXCLUDED.incoterms,
           currency          = EXCLUDED.currency,
           since_month       = EXCLUDED.since_month,
           status            = EXCLUDED.status,
           updated_at        = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          s.supplier_id, s.name, s.country, s.city, s.factory_or_trader,
          s.moq, s.lead_time_days, s.payment_terms, s.incoterms, s.currency,
          s.since_month, s.status,
        ],
      );
      if (result.rows[0]!.inserted) stats.suppliers.created++;
      else stats.suppliers.updated++;
    }

    // Phase 2: upsert SKUs. Resolve supplier name → ID after suppliers are in.
    for (const sku of skus) {
      const supplier_id = resolveSupplier(sku.supplier_name_raw);
      if (sku.supplier_name_raw && !supplier_id) {
        stats.warnings.push(
          `SKU ${sku.asin ?? `EAN ${sku.ean}`}: supplier "${sku.supplier_name_raw}" not in supplier_master. ` +
          `Setting supplier_id NULL.`,
        );
      }
      const result = await pg.query<{ inserted: boolean }>(
        `INSERT INTO brain.sku_master (
           asin, seller_sku, ean, brand, supplier_id,
           moq, lead_time_days, cogs_landed, fba_fee, launched,
           status, marketplace, parent_asin
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10,
           $11, $12, $13
         )
         ON CONFLICT (ean) DO UPDATE SET
           asin           = EXCLUDED.asin,
           seller_sku     = EXCLUDED.seller_sku,
           brand          = EXCLUDED.brand,
           supplier_id    = EXCLUDED.supplier_id,
           moq            = EXCLUDED.moq,
           lead_time_days = EXCLUDED.lead_time_days,
           cogs_landed    = EXCLUDED.cogs_landed,
           -- fba_fee is also written by the import-fba-fees CLI (SP-API
           -- getMyFeesEstimates). COALESCE so a blank CSV cell preserves an
           -- API-sourced value rather than nulling it; a filled cell still wins.
           fba_fee        = COALESCE(EXCLUDED.fba_fee, brain.sku_master.fba_fee),
           launched       = EXCLUDED.launched,
           status         = EXCLUDED.status,
           marketplace    = EXCLUDED.marketplace,
           parent_asin    = EXCLUDED.parent_asin,
           updated_at     = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          sku.asin, sku.seller_sku, sku.ean, sku.brand, supplier_id,
          sku.moq, sku.lead_time_days, sku.cogs_landed, sku.fba_fee, sku.launched,
          sku.status, sku.marketplace, sku.parent_asin,
        ],
      );
      if (result.rows[0]!.inserted) stats.skus.created++;
      else stats.skus.updated++;
    }

    await pg.query('COMMIT');

    const durationMs = Date.now() - startedAt;
    const totalUpserted = stats.suppliers.created + stats.suppliers.updated +
                          stats.skus.created + stats.skus.updated;

    // meta.sync_run.duration_ms is a generated column (finished_at - started_at),
    // so we don't write it — Postgres computes it from finished_at.
    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = 'success',
             rows_fetched = $2, rows_upserted = $2
       WHERE sync_run_id = $1`,
      [syncRunId, totalUpserted],
    );

    console.log('');
    console.log('Done.');
    console.log(`Suppliers: ${stats.suppliers.created} created, ${stats.suppliers.updated} updated, ${stats.suppliers.skipped} skipped`);
    console.log(`SKUs:      ${stats.skus.created} created, ${stats.skus.updated} updated, ${stats.skus.skipped} skipped`);
    if (stats.warnings.length) {
      console.log('');
      console.log(`${stats.warnings.length} warnings:`);
      for (const w of stats.warnings.slice(0, 20)) console.log(`  ${w}`);
      if (stats.warnings.length > 20) console.log(`  ... and ${stats.warnings.length - 20} more`);
    }
    if (stats.errors.length) {
      console.log('');
      console.log(`${stats.errors.length} errors (skipped):`);
      for (const e of stats.errors) console.log(`  ${e}`);
    }
    console.log(`\nsync_run_id ${syncRunId} (${(durationMs / 1000).toFixed(1)}s)`);
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
