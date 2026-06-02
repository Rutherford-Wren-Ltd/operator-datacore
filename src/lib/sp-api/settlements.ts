// ============================================================================
// Settlement report ingest — brain.settlements + brain.settlement_lines.
//
// Report type: GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2
// Response format: TSV (kebab-case columns)
//
// IMPORTANT — settlements are NOT requested. Amazon auto-generates one report
// per settlement cycle (~14 days) and posts it to the seller's report queue.
// Our connector lists DONE settlement reports, dedups against
// brain.settlements, and ingests anything new. This is the inverse of every
// other ingest in operator-datacore (S&T, SQP, orders, finances) — there is
// no createReport step.
//
// What this provides: the truth-of-the-truth on revenue. Settlements are
// what Amazon actually deposited to RW's bank, after all fees, refunds,
// adjustments, and reserves. Pairs with brain.financial_events (the
// per-event posted-as-they-happen view from listFinancialEvents):
//
//   - financial_events:  posted as-they-happen, real-time line items
//   - settlements:       grouped into ~14-day cycles, reconciled to a single
//                        deposit amount that matches the seller's bank
//
// Both live in the lake; choose by question. "What hit my account this
// fortnight?" → settlements. "What's the running fee pattern?" →
// financial_events.
//
// Schema mapping into brain.settlements (header) + brain.settlement_lines:
//   - The TSV repeats the settlement header fields on every row. We pull the
//     header once from the first row (settlement_id, dates, deposit, total,
//     currency), then read each subsequent row as a settlement_line.
//   - Each line's natural-key fields are hashed into line_hash; the PK
//     (settlement_id, line_hash) makes re-pulls of the same report safe.
//
// Marketplace mapping: the TSV has a marketplace-name column (e.g.
// "amazon.co.uk"). We map name → marketplace_id via the table below; an
// unknown name lands as the raw string (will surface in audits).
// ============================================================================

import { createHash } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { SpApiClient } from './client.js';
import { listReports, parseTsv, type ListedReport } from './reports.js';
import { gunzipSync } from 'node:zlib';

const MARKETPLACE_NAME_TO_ID: Record<string, string> = {
  'amazon.com':       'ATVPDKIKX0DER',
  'amazon.ca':        'A2EUQ1WTGCTBG2',
  'amazon.com.mx':    'A1AM78C64UM0Y8',
  'amazon.co.uk':     'A1F83G8C2ARO7P',
  'amazon.de':        'A1PA6795UKMFR9',
  'amazon.fr':        'A13V1IB3VIYZZH',
  'amazon.it':        'APJ6JRA9NG5V4',
  'amazon.es':        'A1RKKUPIHCS9HS',
  'amazon.nl':        'A1805IZSGTT6HS',
  'amazon.se':        'A2NODRKZP88ZB9',
  'amazon.pl':        'A1C3SOZRARQ6R3',
  'amazon.com.tr':    'A33AVAJ2PDY3EV',
  'amazon.co.jp':     'A1VC38T7YXB528',
};

function resolveMarketplaceId(rawName: string | undefined): string {
  if (!rawName) return 'UNKNOWN';
  const lc = rawName.trim().toLowerCase();
  return MARKETPLACE_NAME_TO_ID[lc] ?? rawName;
}

interface SettlementHeader {
  settlement_id: string;
  marketplace_id: string;
  settlement_start_date: string;
  settlement_end_date: string;
  deposit_date: string | null;
  total_amount: number;
  currency_code: string;
}

interface SettlementLine {
  transaction_type: string | null;
  posted_date: string | null;
  amazon_order_id: string | null;
  sku: string | null;
  description: string | null;
  amount: number | null;
  currency_code: string;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface IngestSettlementsOptions {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  /** Only consider settlements created on or after this date. Defaults to 180 days back. */
  since?: Date;
  /** Marketplace filter on the settlement's resolved marketplace_id. Pass empty array to accept all. */
  marketplaceIds?: string[];
}

export interface IngestSettlementsResult {
  reportsListed: number;
  reportsIngested: number;
  reportsSkipped: number;
  settlementsUpserted: number;
  linesInserted: number;
  failures: Array<{ reportId: string; error: string }>;
}

/**
 * Discover available settlement reports on Amazon's side, ingest any not yet
 * in brain.settlements. Idempotent — re-runs are safe.
 */
export async function ingestAvailableSettlements(
  opts: IngestSettlementsOptions,
): Promise<IngestSettlementsResult> {
  const since = opts.since ?? new Date(Date.now() - 180 * 86_400_000);
  const result: IngestSettlementsResult = {
    reportsListed: 0,
    reportsIngested: 0,
    reportsSkipped: 0,
    settlementsUpserted: 0,
    linesInserted: 0,
    failures: [],
  };

  for await (const r of listReports(opts.spClient, {
    reportTypes: ['GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'],
    processingStatuses: ['DONE'],
    createdSince: since,
  })) {
    result.reportsListed += 1;
    if (!r.reportDocumentId) {
      result.reportsSkipped += 1;
      continue;
    }

    // Idempotency: if we've already ingested this report_id, skip.
    const existing = await opts.pg.query<{ raw_id: number; parsed_at: string | null }>(
      `SELECT raw_id, parsed_at FROM raw.sp_api_report
        WHERE report_type = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'
          AND report_id = $1`,
      [r.reportId],
    );
    if (existing.rows.length > 0 && existing.rows[0]!.parsed_at) {
      result.reportsSkipped += 1;
      continue;
    }

    try {
      const ingested = await ingestOneSettlement(opts, r);
      result.reportsIngested += 1;
      result.settlementsUpserted += ingested.settlementUpserted ? 1 : 0;
      result.linesInserted += ingested.linesInserted;
    } catch (err) {
      result.failures.push({
        reportId: r.reportId,
        error: err instanceof Error ? err.message.split('\n')[0]! : String(err),
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

async function ingestOneSettlement(
  opts: IngestSettlementsOptions,
  report: ListedReport,
): Promise<{ settlementUpserted: boolean; linesInserted: number }> {
  // 1. Get the document URL.
  const doc = await opts.spClient.request<{ url: string; compressionAlgorithm?: 'GZIP' }>({
    method: 'GET',
    path: `/reports/2021-06-30/documents/${report.reportDocumentId}`,
  });

  // 2. Fetch + decompress.
  const fetched = await fetch(doc.payload.url);
  if (!fetched.ok) {
    throw new Error(`document fetch failed (${fetched.status})`);
  }
  const buf = Buffer.from(await fetched.arrayBuffer());
  const rawText = doc.payload.compressionAlgorithm === 'GZIP'
    ? gunzipSync(buf).toString('utf8')
    : buf.toString('utf8');

  // 3. Land the raw page.
  const rawInsert = await opts.pg.query<{ raw_id: number }>(
    `INSERT INTO raw.sp_api_report
       (connection_id, sync_run_id, report_type, report_id, document_id, marketplace_ids,
        data_start_time, data_end_time, processing_status, payload, payload_bytes, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, $10, NOW())
     ON CONFLICT (report_type, report_id) DO UPDATE
       SET processing_status = EXCLUDED.processing_status, parsed_at = NULL
     RETURNING raw_id`,
    [
      opts.connectionId,
      opts.syncRunId,
      'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
      report.reportId,
      report.reportDocumentId,
      report.marketplaceIds ?? null,
      report.dataStartTime ?? null,
      report.dataEndTime ?? null,
      report.processingStatus,
      Buffer.byteLength(rawText, 'utf8'),
    ],
  );
  const rawId = rawInsert.rows[0]!.raw_id;

  // 4. Parse TSV.
  const rows = parseTsv(rawText);
  if (rows.length === 0) {
    await opts.pg.query('UPDATE raw.sp_api_report SET parsed_at = NOW(), parse_error = $2 WHERE raw_id = $1',
      [rawId, 'empty TSV — no rows after header']);
    return { settlementUpserted: false, linesInserted: 0 };
  }

  // 5. Extract the settlement header from the first row (the TSV repeats it on every row).
  const first = rows[0]!;
  const header: SettlementHeader = {
    settlement_id: first['settlement-id'] ?? '',
    marketplace_id: resolveMarketplaceId(first['marketplace-name']),
    settlement_start_date: first['settlement-start-date'] ?? '',
    settlement_end_date:   first['settlement-end-date']   ?? '',
    deposit_date:          first['deposit-date'] || null,
    total_amount:          Number(first['total-amount']) || 0,
    currency_code:         (first.currency || 'USD').trim().slice(0, 3).toUpperCase(),
  };

  if (!header.settlement_id) {
    await opts.pg.query('UPDATE raw.sp_api_report SET parsed_at = NOW(), parse_error = $2 WHERE raw_id = $1',
      [rawId, 'first row missing settlement-id']);
    return { settlementUpserted: false, linesInserted: 0 };
  }

  // Optional marketplace filter.
  if (opts.marketplaceIds && opts.marketplaceIds.length > 0
      && !opts.marketplaceIds.includes(header.marketplace_id)) {
    await opts.pg.query('UPDATE raw.sp_api_report SET parsed_at = NOW(), parse_error = $2 WHERE raw_id = $1',
      [rawId, `marketplace ${header.marketplace_id} filtered out by caller`]);
    return { settlementUpserted: false, linesInserted: 0 };
  }

  // 6. Upsert header.
  await opts.pg.query(
    `INSERT INTO brain.settlements (
       settlement_id, marketplace_id,
       settlement_start_date, settlement_end_date, deposit_date,
       total_amount, currency_code, raw_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (settlement_id) DO UPDATE SET
       marketplace_id        = EXCLUDED.marketplace_id,
       settlement_start_date = EXCLUDED.settlement_start_date,
       settlement_end_date   = EXCLUDED.settlement_end_date,
       deposit_date          = EXCLUDED.deposit_date,
       total_amount          = EXCLUDED.total_amount,
       currency_code         = EXCLUDED.currency_code,
       raw_id                = EXCLUDED.raw_id`,
    [
      header.settlement_id,
      header.marketplace_id,
      header.settlement_start_date,
      header.settlement_end_date,
      header.deposit_date,
      header.total_amount,
      header.currency_code,
      rawId,
    ],
  );

  // 7. Insert lines. Every row in the TSV after the header is a line item;
  //    the header repetition on each row is informational.
  //    First row is sometimes the settlement-total row (no transaction-type
  //    or amount-description) — preserve it as a settlement-level line so
  //    the totals can be reconciled.
  let linesInserted = 0;
  for (const row of rows) {
    const amount = row.amount ? Number(row.amount) : null;
    if (amount !== null && !Number.isFinite(amount)) continue;

    const line: SettlementLine = {
      transaction_type: row['transaction-type'] || null,
      posted_date:      row['posted-date'] || row['posted-date-time'] || null,
      amazon_order_id:  row['order-id'] || null,
      sku:              row.sku || null,
      description:      row['amount-description'] || null,
      amount,
      currency_code:    header.currency_code,
    };

    const lineHash = hashLine(header.settlement_id, line, row);
    const ins = await opts.pg.query<{ settlement_id: string }>(
      `INSERT INTO brain.settlement_lines (
         settlement_id, line_hash,
         transaction_type, posted_date, amazon_order_id, sku, description,
         amount, currency_code, raw_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (settlement_id, line_hash) DO NOTHING
       RETURNING settlement_id`,
      [
        header.settlement_id,
        lineHash,
        line.transaction_type,
        line.posted_date,
        line.amazon_order_id,
        line.sku,
        line.description,
        line.amount,
        line.currency_code,
        rawId,
      ],
    );
    if (ins.rows.length > 0) linesInserted += 1;
  }

  // 8. Mark parsed.
  await opts.pg.query(
    'UPDATE raw.sp_api_report SET parsed_at = NOW() WHERE raw_id = $1',
    [rawId],
  );

  return { settlementUpserted: true, linesInserted };
}

function hashLine(
  settlementId: string,
  line: SettlementLine,
  row: Record<string, string>,
): string {
  // Hash from natural-key fields. Include a few additional TSV columns
  // (fulfillment-id, shipment-id, order-item-code) so two lines with the
  // same description but different shipments get distinct hashes.
  const sig = [
    settlementId,
    line.transaction_type ?? '',
    line.posted_date ?? '',
    line.amazon_order_id ?? '',
    line.sku ?? '',
    line.description ?? '',
    (line.amount ?? 0).toFixed(4),
    row['fulfillment-id'] ?? '',
    row['shipment-id'] ?? '',
    row['order-item-code'] ?? '',
    row['adjustment-id'] ?? '',
  ].join('|');
  return createHash('sha256').update(sig).digest('hex').slice(0, 32);
}
