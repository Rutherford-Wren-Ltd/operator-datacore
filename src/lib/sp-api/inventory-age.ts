// ============================================================================
// FBA Inventory Age - per-FNSKU physical age buckets + aged-inventory surcharge.
//
// Report type: GET_FBA_INVENTORY_AGED_DATA (a.k.a. "FBA Inventory Age" /
// aged-inventory-surcharge report). Response format: TSV.
//
// What this is for: the lake had no measure of how physically OLD inventory is,
// only velocity-derived cover. The aged-inventory surcharge (271+ days) is a real
// cost on overstock that the per-FNSKU storage report did not carry. This report
// gives unit counts by age bucket plus Amazon's own estimated storage and aged
// surcharge per SKU. Lands in brain.fba_inventory_age (migration 0040).
//
// Header drift: like the storage report, GET_FBA_INVENTORY_AGED_DATA headers vary
// by marketplace and over time, and the aged-inventory-surcharge (AIS) rename
// changed several column names. We map via case/-/_ -insensitive alias lookup and
// sum the AIS buckets. The exact header strings on this LWA app should be verified
// empirically on first run (as was done for the storage report).
//
// Idempotency: brain.fba_inventory_age PK (snapshot_date, marketplace_id, fnsku)
// makes re-ingest a safe upsert.
// ============================================================================

import { Client as PgClient } from 'pg';
import { SpApiClient } from './client.js';
import { runReport, parseTsv, ReportCancelledError } from './reports.js';

// The FBA inventory-age buckets (inv-age-0-to-90-days .. 365-plus) and the
// estimated storage / aged-inventory-surcharge columns live in the FBA
// Inventory Planning / restock report. 'GET_FBA_INVENTORY_AGED_DATA' is NOT a
// valid SP-API report type (it is accepted then returns FATAL).
export const INVENTORY_AGE_REPORT_TYPE = 'GET_FBA_INVENTORY_PLANNING_DATA';

/** Locale-aware numeric parse (UK 1,234.56 vs EU 1.234,56). Empty -> null. */
function parseNumeric(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const cleaned = v.replace(/[^\d.,-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');
  if (hasDot && hasComma) {
    const n = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? Number(cleaned.replace(/\./g, '').replace(',', '.'))
      : Number(cleaned.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (hasComma) {
    const n = Number(cleaned.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Integer parse (units). */
function parseInt0(v: string | undefined): number | null {
  const n = parseNumeric(v);
  return n === null ? null : Math.round(n);
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

/** Sum the present values among several header aliases (treat missing as 0). */
function sumAliases(row: Record<string, string>, normMap: Map<string, string>, aliases: string[]): number {
  let total = 0;
  for (const a of aliases) {
    const key = normMap.get(norm(a));
    if (key !== undefined) {
      const n = parseNumeric(row[key]);
      if (n !== null) total += n;
    }
  }
  return total;
}

/** Parse a snapshot date 'YYYY-MM-DD' (or fall back to today UTC). */
function parseSnapshotDate(v: string | undefined, fallback: Date): string {
  const fb = `${fallback.getUTCFullYear()}-${String(fallback.getUTCMonth() + 1).padStart(2, '0')}-${String(fallback.getUTCDate()).padStart(2, '0')}`;
  if (!v) return fb;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : fb;
}

export interface InventoryAgeRow {
  snapshotDate: string;
  marketplaceId: string;
  fnsku: string;
  asin: string | null;
  canonicalSku: string | null;
  productName: string | null;
  condition: string | null;
  qtyAvailable: number | null;
  invAge0_90: number | null;
  invAge91_180: number | null;
  invAge181_270: number | null;
  invAge271_365: number | null;
  invAge365Plus: number | null;
  estimatedStorageCost: number | null;
  estimatedAgedSurcharge: number | null;
  qtyToBeChargedAged: number | null;
  currencyCode: string | null;
}

/** Parse the FBA inventory-age TSV into typed rows (one per fnsku). */
export function parseInventoryAgeReport(rawText: string, marketplaceId: string, fallback: Date): InventoryAgeRow[] {
  const rows = parseTsv(rawText);
  if (rows.length === 0) return [];
  const normMap = new Map<string, string>();
  for (const key of Object.keys(rows[0]!)) normMap.set(norm(key), key);

  const out: InventoryAgeRow[] = [];
  for (const row of rows) {
    const fnsku = pick(row, normMap, ['fnsku']);
    if (!fnsku) continue; // skip totals / blank rows

    out.push({
      snapshotDate: parseSnapshotDate(pick(row, normMap, ['snapshot_date', 'snapshot-date', 'date']), fallback),
      marketplaceId,
      fnsku,
      asin: pick(row, normMap, ['asin']) ?? null,
      canonicalSku: pick(row, normMap, ['sku', 'seller_sku', 'merchant_sku']) ?? null,
      productName: pick(row, normMap, ['product_name', 'product-name']) ?? null,
      condition: pick(row, normMap, ['condition', 'inventory_condition']) ?? null,
      qtyAvailable: parseInt0(pick(row, normMap, ['available', 'quantity_available', 'afn_fulfillable_quantity', 'qty_available'])),
      invAge0_90: parseInt0(pick(row, normMap, ['inv_age_0_to_90_days', 'inventory_age_0_to_90_days', 'units_age_0_to_90_days'])),
      invAge91_180: parseInt0(pick(row, normMap, ['inv_age_91_to_180_days', 'inventory_age_91_to_180_days', 'units_age_91_to_180_days'])),
      invAge181_270: parseInt0(pick(row, normMap, ['inv_age_181_to_270_days', 'inventory_age_181_to_270_days', 'units_age_181_to_270_days'])),
      invAge271_365: parseInt0(pick(row, normMap, ['inv_age_271_to_365_days', 'inventory_age_271_to_365_days', 'units_age_271_to_365_days'])),
      invAge365Plus: parseInt0(pick(row, normMap, ['inv_age_365_plus_days', 'inventory_age_365_plus_days', 'units_age_365_plus_days', 'inv_age_365_to_730_days'])),
      estimatedStorageCost: parseNumeric(pick(row, normMap, ['estimated_storage_cost_next_charge', 'estimated_monthly_storage_fee', 'estimated_storage_cost'])),
      // Aged-inventory surcharge: sum whatever AIS/LTSF estimate buckets are present.
      estimatedAgedSurcharge: sumAliases(row, normMap, [
        'estimated_aged_inventory_surcharge',
        'estimated_ais_181_to_210_days', 'estimated_ais_211_to_240_days', 'estimated_ais_241_to_270_days',
        'estimated_ais_271_to_300_days', 'estimated_ais_301_to_330_days', 'estimated_ais_331_to_365_days',
        'estimated_ais_271_to_365_days', 'estimated_ais_365_plus_days',
        'estimated_long_term_storage_fee_next_charge', 'estimated_long_term_storage_fee',
      ]) || null,
      qtyToBeChargedAged: parseInt0(pick(row, normMap, [
        'qty_to_be_charged_ais_271_to_365_days', 'qty_to_be_charged_ais_365_plus_days',
        'quantity_to_be_charged_ais_271_to_365_days', 'units_to_be_charged_ltsf',
      ])),
      currencyCode: (pick(row, normMap, ['currency', 'currency_code']) ?? null)?.toUpperCase().slice(0, 3) ?? null,
    });
  }
  return out;
}

export interface IngestInventoryAgeOpts {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  marketplaceIds: string[];
  asOf: Date;
}

export interface IngestInventoryAgeResult {
  reportStatus: 'parsed' | 'no_data';
  rowsParsed: number;
  rowsUpserted: number;
  snapshotsSeen: string[];
}

/**
 * Pull the latest GET_FBA_INVENTORY_AGED_DATA for the given marketplaces and
 * upsert per-FNSKU age rows into brain.fba_inventory_age. Idempotent via the PK.
 */
export async function ingestInventoryAge(opts: IngestInventoryAgeOpts): Promise<IngestInventoryAgeResult> {
  const result: IngestInventoryAgeResult = { reportStatus: 'no_data', rowsParsed: 0, rowsUpserted: 0, snapshotsSeen: [] };

  let report;
  try {
    report = await runReport(opts.spClient, {
      reportType: INVENTORY_AGE_REPORT_TYPE,
      marketplaceIds: opts.marketplaceIds,
      // Inventory-age is a point-in-time snapshot report: request it with NO
      // date window. Amazon rejects an endDate supplied without a startDate
      // ("The endDate does not have a corresponding startDate") and returns the
      // current snapshot when neither is given.
    });
  } catch (err) {
    if (err instanceof ReportCancelledError) return result;
    throw err;
  }

  const marketplaceId = report.meta.marketplaceIds?.[0] ?? opts.marketplaceIds[0]!;
  const parsed = parseInventoryAgeReport(report.rawText, marketplaceId, opts.asOf);
  result.rowsParsed = parsed.length;
  if (parsed.length === 0) return result;
  result.reportStatus = 'parsed';

  const rawInsert = await opts.pg.query<{ raw_id: number }>(
    `INSERT INTO raw.sp_api_report
       (connection_id, sync_run_id, report_type, report_id, document_id, marketplace_ids,
        data_start_time, data_end_time, processing_status, payload, payload_bytes, fetched_at, parsed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb,$10,NOW(),NOW())
     ON CONFLICT (report_type, report_id) DO UPDATE
       SET payload_bytes = EXCLUDED.payload_bytes, parsed_at = NOW()
     RETURNING raw_id`,
    [
      opts.connectionId, opts.syncRunId, INVENTORY_AGE_REPORT_TYPE, report.meta.reportId,
      report.meta.reportDocumentId ?? null, report.meta.marketplaceIds ?? opts.marketplaceIds,
      report.meta.dataStartTime ?? null,
      report.meta.dataEndTime ?? opts.asOf.toISOString(),
      report.meta.processingStatus, Buffer.byteLength(report.rawText, 'utf8'),
    ],
  );
  const rawId = rawInsert.rows[0]!.raw_id;

  const snapshots = new Set<string>();
  for (const r of parsed) {
    snapshots.add(r.snapshotDate);
    await opts.pg.query(
      `INSERT INTO brain.fba_inventory_age (
         snapshot_date, marketplace_id, fnsku, asin, canonical_sku, product_name, condition,
         qty_available, inv_age_0_90, inv_age_91_180, inv_age_181_270, inv_age_271_365, inv_age_365_plus,
         estimated_storage_cost, estimated_aged_surcharge, qty_to_be_charged_aged,
         currency_code, report_type, raw_id, ingested_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
       ON CONFLICT (snapshot_date, marketplace_id, fnsku) DO UPDATE SET
         asin=EXCLUDED.asin, canonical_sku=EXCLUDED.canonical_sku, product_name=EXCLUDED.product_name,
         condition=EXCLUDED.condition, qty_available=EXCLUDED.qty_available,
         inv_age_0_90=EXCLUDED.inv_age_0_90, inv_age_91_180=EXCLUDED.inv_age_91_180,
         inv_age_181_270=EXCLUDED.inv_age_181_270, inv_age_271_365=EXCLUDED.inv_age_271_365,
         inv_age_365_plus=EXCLUDED.inv_age_365_plus, estimated_storage_cost=EXCLUDED.estimated_storage_cost,
         estimated_aged_surcharge=EXCLUDED.estimated_aged_surcharge, qty_to_be_charged_aged=EXCLUDED.qty_to_be_charged_aged,
         currency_code=EXCLUDED.currency_code, report_type=EXCLUDED.report_type, raw_id=EXCLUDED.raw_id, ingested_at=NOW()`,
      [
        r.snapshotDate, r.marketplaceId, r.fnsku, r.asin, r.canonicalSku, r.productName, r.condition,
        r.qtyAvailable, r.invAge0_90, r.invAge91_180, r.invAge181_270, r.invAge271_365, r.invAge365Plus,
        r.estimatedStorageCost, r.estimatedAgedSurcharge, r.qtyToBeChargedAged,
        r.currencyCode, INVENTORY_AGE_REPORT_TYPE, rawId,
      ],
    );
    result.rowsUpserted += 1;
  }

  result.snapshotsSeen = Array.from(snapshots).sort();
  return result;
}
