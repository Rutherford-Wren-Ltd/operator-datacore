// ============================================================================
// FBA Storage Fees — per-FNSKU monthly storage + aged/long-term surcharge.
//
// Report type: GET_FBA_STORAGE_FEE_CHARGES_DATA (primary, monthly storage)
// Response format: TSV
//
// What this is for: the per-SKU storage cost the lake was missing. FBA storage
// and long-term-storage land in brain.financial_events only as account-level
// ServiceFeeEvent rows with NO sku attribution. This report breaks the monthly
// storage charge down per-FNSKU, which lets analytics.product_profitability_30d
// compute a true CM3 (the vault definition includes storage).
//
// Cadence: this report is MONTHLY. Amazon generates it for a recent closed
// month; it is not arbitrarily date-rangeable. We request it, then read each
// row's `month_of_charge` to stamp charge_month. Backfilling arbitrary old
// months is not supported by the report (documented limitation).
//
// Header drift: GET_FBA_STORAGE_FEE_CHARGES_DATA column headers vary by
// marketplace and over time (asin vs ASIN, estimated_monthly_storage_fee vs
// estimated-monthly-storage-fee, etc). We therefore map headers via
// case/-/_ -insensitive alias lookup rather than fixed indexing. Unknown but
// non-fatal: the exact header strings on this LWA app — verified empirically
// on first run.
//
// Idempotency: the brain.fba_storage_fees PK (charge_month, marketplace_id,
// fnsku, fee_type) makes re-ingest a safe upsert. raw.sp_api_report is written
// for provenance only (each createReport mints a fresh reportId, so it does not
// dedupe across runs — the table PK does).
// ============================================================================

import { Client as PgClient } from 'pg';
import { SpApiClient } from './client.js';
import { runReport, parseTsv, ReportCancelledError } from './reports.js';

export const STORAGE_FEE_REPORT_TYPE = 'GET_FBA_STORAGE_FEE_CHARGES_DATA';

/**
 * Locale-aware numeric parse (UK `1,234.56` vs EU `1.234,56`). The decimal
 * separator is whichever of '.'/',' appears LAST. Empty/unparseable -> null.
 * Mirrors the settlement parser's logic so EU storage reports parse correctly.
 */
function parseNumeric(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const cleaned = v.replace(/[^\d.,-]/g, ''); // strip currency symbols, spaces
  if (cleaned === '' || cleaned === '-') return null;
  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');
  if (hasDot && hasComma) {
    const n = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? Number(cleaned.replace(/\./g, '').replace(',', '.')) // EU
      : Number(cleaned.replace(/,/g, ''));                   // UK/US
    return Number.isFinite(n) ? n : null;
  }
  if (hasComma) {
    const n = Number(cleaned.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Normalise a header for alias matching: lowercase, strip spaces/-/_. */
function norm(h: string): string {
  return h.toLowerCase().replace(/[\s_-]+/g, '');
}

/** Pick the first present, non-empty value among header aliases. */
function pick(row: Record<string, string>, normMap: Map<string, string>, aliases: string[]): string | undefined {
  for (const a of aliases) {
    const key = normMap.get(norm(a));
    if (key !== undefined) {
      const val = row[key];
      if (val !== undefined && val !== '') return val;
    }
  }
  return undefined;
}

/**
 * Parse `month_of_charge` into the first day of that month (YYYY-MM-01).
 * Handles 'YYYY-MM', 'YYYY-MM-DD', 'Mon YYYY' ('May 2026'), 'MM/YYYY'.
 * Falls back to `fallbackMonth` (first-of-month Date) when unparseable.
 */
function parseChargeMonth(v: string | undefined, fallbackMonth: Date): string {
  const fb = `${fallbackMonth.getUTCFullYear()}-${String(fallbackMonth.getUTCMonth() + 1).padStart(2, '0')}-01`;
  if (!v) return fb;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (m) return `${m[1]}-${m[2]}-01`;
  m = s.match(/^(\d{2})\/(\d{4})$/);
  if (m) return `${m[2]}-${m[1]}-01`;
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
  if (m && months[m[1]!.toLowerCase()]) return `${m[2]}-${months[m[1]!.toLowerCase()]}-01`;
  return fb;
}

interface StorageFeeRow {
  chargeMonth: string;
  marketplaceId: string;
  fnsku: string;
  asin: string | null;
  canonicalSku: string | null;
  productName: string | null;
  feeType: 'monthly_storage' | 'long_term_storage' | 'aged_surcharge';
  averageQuantityOnHand: number | null;
  storageVolume: number | null;
  estimatedFee: number;
  currencyCode: string;
}

/** Parse a storage-charges TSV into typed fee rows (one per fee_type present). */
export function parseStorageFeeReport(rawText: string, marketplaceId: string, fallbackMonth: Date): StorageFeeRow[] {
  const rows = parseTsv(rawText);
  if (rows.length === 0) return [];
  const normMap = new Map<string, string>();
  for (const key of Object.keys(rows[0]!)) normMap.set(norm(key), key);

  const out: StorageFeeRow[] = [];
  for (const row of rows) {
    const fnsku = pick(row, normMap, ['fnsku']);
    if (!fnsku) continue; // skip totals / blank rows
    const chargeMonth = parseChargeMonth(pick(row, normMap, ['month_of_charge', 'charge_month', 'month']), fallbackMonth);
    const asin = pick(row, normMap, ['asin']) ?? null;
    const canonicalSku = pick(row, normMap, ['sku', 'seller_sku', 'merchant_sku']) ?? null;
    const productName = pick(row, normMap, ['product_name', 'product-name']) ?? null;
    const avgQty = parseNumeric(pick(row, normMap, ['average_quantity_on_hand', 'average_quantity_customer_orders', 'average_quantity']));
    const volume = parseNumeric(pick(row, normMap, ['item_volume', 'total_item_volume', 'estimated_total_item_volume', 'volume']));
    const currency = (pick(row, normMap, ['currency', 'currency_code']) ?? 'GBP').toUpperCase().slice(0, 3);

    const monthly = parseNumeric(pick(row, normMap, ['estimated_monthly_storage_fee', 'monthly_storage_fee', 'estimated_storage_fee']));
    const aged = parseNumeric(pick(row, normMap, ['estimated_aged_inventory_surcharge', 'aged_inventory_surcharge', 'aged_surcharge']));
    const ltsf = parseNumeric(pick(row, normMap, ['estimated_long_term_storage_fee', 'long_term_storage_fee', 'estimated_long_term_storage_fee_next_charge']));

    const base = {
      chargeMonth, marketplaceId, fnsku, asin, canonicalSku, productName,
      averageQuantityOnHand: avgQty, storageVolume: volume, currencyCode: currency,
    };
    if (monthly !== null && monthly !== 0) out.push({ ...base, feeType: 'monthly_storage', estimatedFee: monthly });
    if (aged !== null && aged !== 0) out.push({ ...base, feeType: 'aged_surcharge', estimatedFee: aged });
    if (ltsf !== null && ltsf !== 0) out.push({ ...base, feeType: 'long_term_storage', estimatedFee: ltsf });
  }
  return out;
}

export interface ItemDimRow {
  marketplaceId: string;
  fnsku: string;
  asin: string | null;
  productName: string | null;
  longestSideCm: number | null;
  medianSideCm: number | null;
  shortestSideCm: number | null;
  weightKg: number | null;
  itemVolumeM3: number | null;
  sizeTier: string | null;
  snapshotMonth: string;
}

/**
 * Parse per-item PACKAGED dimensions from the storage report (one row per
 * fnsku). Normalises units: NA reports sides in inches / weight in pounds /
 * volume in cubic feet; EU in cm / kg / m^3. We convert everything to cm/kg/m^3
 * using the report's own *_units columns.
 */
export function parseItemDimensions(rawText: string, marketplaceId: string, fallbackMonth: Date): ItemDimRow[] {
  const rows = parseTsv(rawText);
  if (rows.length === 0) return [];
  const normMap = new Map<string, string>();
  for (const key of Object.keys(rows[0]!)) normMap.set(norm(key), key);

  const toCm = (v: number | null, unit: string | undefined) =>
    v === null ? null : (/(inch|in\b)/i.test(unit ?? '') ? v * 2.54 : v);
  const toKg = (v: number | null, unit: string | undefined) =>
    v === null ? null : (/(pound|lb)/i.test(unit ?? '') ? v * 0.453592 : v);
  const toM3 = (v: number | null, unit: string | undefined) =>
    v === null ? null : (/(feet|foot|ft|cubic\s*f)/i.test(unit ?? '') ? v * 0.0283168 : v);

  const seen = new Set<string>();
  const out: ItemDimRow[] = [];
  for (const row of rows) {
    const fnsku = pick(row, normMap, ['fnsku']);
    if (!fnsku || seen.has(fnsku)) continue;
    seen.add(fnsku);
    const lenUnit = pick(row, normMap, ['measurement_units', 'dimension_units']);
    const wtUnit = pick(row, normMap, ['weight_units']);
    const volUnit = pick(row, normMap, ['volume_units']);
    out.push({
      marketplaceId, fnsku,
      asin: pick(row, normMap, ['asin']) ?? null,
      productName: pick(row, normMap, ['product_name', 'product-name']) ?? null,
      longestSideCm: toCm(parseNumeric(pick(row, normMap, ['longest_side'])), lenUnit),
      medianSideCm: toCm(parseNumeric(pick(row, normMap, ['median_side'])), lenUnit),
      shortestSideCm: toCm(parseNumeric(pick(row, normMap, ['shortest_side'])), lenUnit),
      weightKg: toKg(parseNumeric(pick(row, normMap, ['weight', 'item_weight'])), wtUnit),
      itemVolumeM3: toM3(parseNumeric(pick(row, normMap, ['item_volume', 'volume'])), volUnit),
      sizeTier: pick(row, normMap, ['product_size_tier', 'size_tier']) ?? null,
      snapshotMonth: parseChargeMonth(pick(row, normMap, ['month_of_charge', 'charge_month', 'month']), fallbackMonth),
    });
  }
  return out;
}

export interface IngestStorageFeesOpts {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  marketplaceIds: string[];
  /** Used to stamp charge_month when the report omits month_of_charge, and as
   *  the report's dataEndTime. Defaults handled by the CLI. */
  asOfMonth: Date;
}

export interface IngestStorageFeesResult {
  reportStatus: 'parsed' | 'no_data';
  rowsParsed: number;
  rowsUpserted: number;
  monthsSeen: string[];
}

/**
 * Pull the latest GET_FBA_STORAGE_FEE_CHARGES_DATA for the given marketplaces
 * and upsert per-FNSKU fee rows into brain.fba_storage_fees. Idempotent via the
 * table PK. Returns counts for the CLI banner.
 */
export async function ingestStorageFees(opts: IngestStorageFeesOpts): Promise<IngestStorageFeesResult> {
  const result: IngestStorageFeesResult = { reportStatus: 'no_data', rowsParsed: 0, rowsUpserted: 0, monthsSeen: [] };

  // The storage charges report covers the most recent closed month. Provide a
  // ~2-month window so Amazon resolves it; the row's month_of_charge is
  // authoritative for charge_month.
  const dataEndTime = opts.asOfMonth;
  const dataStartTime = new Date(Date.UTC(dataEndTime.getUTCFullYear(), dataEndTime.getUTCMonth() - 1, 1));

  let report;
  try {
    report = await runReport(opts.spClient, {
      reportType: STORAGE_FEE_REPORT_TYPE,
      marketplaceIds: opts.marketplaceIds,
      dataStartTime,
      dataEndTime,
    });
  } catch (err) {
    if (err instanceof ReportCancelledError) return result; // no data for window
    throw err;
  }

  const marketplaceId = report.meta.marketplaceIds?.[0] ?? opts.marketplaceIds[0]!;
  const parsed = parseStorageFeeReport(report.rawText, marketplaceId, dataEndTime);
  result.rowsParsed = parsed.length;
  if (parsed.length === 0) return result;
  result.reportStatus = 'parsed';

  // Provenance row (idempotency is enforced by the fba_storage_fees PK).
  const rawInsert = await opts.pg.query<{ raw_id: number }>(
    `INSERT INTO raw.sp_api_report
       (connection_id, sync_run_id, report_type, report_id, document_id, marketplace_ids,
        data_start_time, data_end_time, processing_status, payload, payload_bytes, fetched_at, parsed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb,$10,NOW(),NOW())
     ON CONFLICT (report_type, report_id) DO UPDATE
       SET payload_bytes = EXCLUDED.payload_bytes, parsed_at = NOW()
     RETURNING raw_id`,
    [
      opts.connectionId, opts.syncRunId, STORAGE_FEE_REPORT_TYPE, report.meta.reportId,
      report.meta.reportDocumentId ?? null, report.meta.marketplaceIds ?? opts.marketplaceIds,
      report.meta.dataStartTime ?? dataStartTime.toISOString(),
      report.meta.dataEndTime ?? dataEndTime.toISOString(),
      report.meta.processingStatus, Buffer.byteLength(report.rawText, 'utf8'),
    ],
  );
  const rawId = rawInsert.rows[0]!.raw_id;

  const months = new Set<string>();
  for (const r of parsed) {
    months.add(r.chargeMonth);
    await opts.pg.query(
      `INSERT INTO brain.fba_storage_fees (
        charge_month, marketplace_id, fnsku, asin, canonical_sku, product_name,
        fee_type, average_quantity_on_hand, storage_volume, estimated_fee,
        currency_code, report_type, raw_id, ingested_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (charge_month, marketplace_id, fnsku, fee_type) DO UPDATE SET
        asin                     = EXCLUDED.asin,
        canonical_sku            = EXCLUDED.canonical_sku,
        product_name             = EXCLUDED.product_name,
        average_quantity_on_hand = EXCLUDED.average_quantity_on_hand,
        storage_volume           = EXCLUDED.storage_volume,
        estimated_fee            = EXCLUDED.estimated_fee,
        currency_code            = EXCLUDED.currency_code,
        report_type              = EXCLUDED.report_type,
        raw_id                   = EXCLUDED.raw_id,
        ingested_at              = NOW()`,
      [
        r.chargeMonth, r.marketplaceId, r.fnsku, r.asin, r.canonicalSku, r.productName,
        r.feeType, r.averageQuantityOnHand, r.storageVolume, r.estimatedFee,
        r.currencyCode, STORAGE_FEE_REPORT_TYPE, rawId,
      ],
    );
    result.rowsUpserted += 1;
  }

  // Per-item packaged dimensions (knowledge base) from the same report.
  const dims = parseItemDimensions(report.rawText, marketplaceId, dataEndTime);
  for (const d of dims) {
    await opts.pg.query(
      `INSERT INTO brain.fba_item_dimensions (
         marketplace_id, fnsku, asin, product_name, longest_side_cm, median_side_cm,
         shortest_side_cm, item_weight_kg, item_volume_m3, product_size_tier, snapshot_month, ingested_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (marketplace_id, fnsku) DO UPDATE SET
         asin=EXCLUDED.asin, product_name=EXCLUDED.product_name,
         longest_side_cm=EXCLUDED.longest_side_cm, median_side_cm=EXCLUDED.median_side_cm,
         shortest_side_cm=EXCLUDED.shortest_side_cm, item_weight_kg=EXCLUDED.item_weight_kg,
         item_volume_m3=EXCLUDED.item_volume_m3, product_size_tier=EXCLUDED.product_size_tier,
         snapshot_month=EXCLUDED.snapshot_month, ingested_at=NOW()`,
      [d.marketplaceId, d.fnsku, d.asin, d.productName, d.longestSideCm, d.medianSideCm,
       d.shortestSideCm, d.weightKg, d.itemVolumeM3, d.sizeTier, d.snapshotMonth],
    );
  }

  result.monthsSeen = Array.from(months).sort();
  return result;
}
